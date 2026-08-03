use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::Paths;
use crate::download::{needs_download, Task};
use crate::error::Result;
use crate::manifest::Mode;
use crate::util::{read_json, sanitize_relative, write_json};

/// Что лаунчер уже поставил в папку режима — нужно, чтобы отличать
/// «файл убрали из сборки» от «игрок положил свой мод».
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceState {
    pub version_id: String,
    pub mode_version: Option<String>,
    pub installed: Vec<String>,
    pub installed_at: Option<String>,
}

impl InstanceState {
    pub fn load(paths: &Paths, mode_id: &str) -> Self {
        read_json(&paths.instance_state(mode_id)).unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths, mode_id: &str) -> Result<()> {
        write_json(&paths.instance_state(mode_id), self)
    }
}

#[derive(Debug, Default)]
pub struct SyncPlan {
    pub download: Vec<Task>,
    pub delete: Vec<PathBuf>,
    pub download_bytes: u64,
}

impl SyncPlan {
    pub fn is_empty(&self) -> bool {
        self.download.is_empty() && self.delete.is_empty()
    }
}

/// Простой глоб: поддерживает `*` в любом месте шаблона.
fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.replace('\\', "/");
    let value = value.replace('\\', "/");
    if !pattern.contains('*') {
        return pattern == value || value.starts_with(&format!("{pattern}/"));
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut cursor = 0usize;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match value[cursor..].find(part) {
            Some(found) => {
                if index == 0 && found != 0 {
                    return false;
                }
                cursor += found + part.len();
            }
            None => return false,
        }
    }
    if let Some(last) = parts.last() {
        if !last.is_empty() && !value.ends_with(last) {
            return false;
        }
    }
    true
}

fn rel_str(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Считает, что скачать и что удалить, чтобы папка режима совпала с манифестом.
pub fn plan(mode: &Mode, paths: &Paths, state: &InstanceState, verify: bool) -> Result<SyncPlan> {
    let instance = paths.instance(&mode.id);
    let mut plan = SyncPlan::default();
    let mut expected: HashSet<String> = HashSet::new();

    for file in &mode.files {
        let rel = sanitize_relative(&file.path)?;
        let rel_display = rel.to_string_lossy().replace('\\', "/");
        expected.insert(rel_display.clone());

        let dest = instance.join(&rel);
        let task = Task::new(file.url.clone(), dest.clone())
            .with_hash(file.sha1.clone(), file.size);

        if file.optional && !dest.exists() && state.installed.contains(&rel_display) {
            // Игрок сам удалил необязательный файл — не навязываемся.
            continue;
        }
        if needs_download(&task, verify) {
            plan.download_bytes += file.size.unwrap_or(0);
            plan.download.push(task);
        }
    }

    // Чистим управляемые папки от файлов, которых больше нет в сборке.
    for dir in mode.managed_dirs() {
        let Ok(rel_dir) = sanitize_relative(&dir) else {
            continue;
        };
        let abs_dir = instance.join(&rel_dir);
        if !abs_dir.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&abs_dir)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = rel_str(&instance, entry.path());
            if expected.contains(&rel) {
                continue;
            }
            if mode.keep.iter().any(|pattern| glob_match(pattern, &rel)) {
                continue;
            }
            // Чужие файлы не трогаем: удаляем только то, что ставили сами.
            if !state.installed.contains(&rel) {
                continue;
            }
            plan.delete.push(entry.path().to_path_buf());
        }
    }

    Ok(plan)
}

pub fn apply_deletions(plan: &SyncPlan) -> Result<()> {
    for path in &plan.delete {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    for path in &plan.delete {
        if let Some(parent) = path.parent() {
            prune_empty_dirs(parent);
        }
    }
    Ok(())
}

fn prune_empty_dirs(dir: &Path) {
    let mut current = dir.to_path_buf();
    loop {
        match std::fs::read_dir(&current) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if std::fs::remove_dir(&current).is_err() {
            return;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return,
        }
    }
}

/// Список путей, которые лаунчер считает своими после успешной установки.
pub fn installed_paths(mode: &Mode) -> Vec<String> {
    mode.files
        .iter()
        .filter_map(|file| sanitize_relative(&file.path).ok())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::glob_match;

    #[test]
    fn glob_patterns() {
        assert!(glob_match("config/keybinds.txt", "config/keybinds.txt"));
        assert!(glob_match("config", "config/sodium.json"));
        assert!(glob_match("mods/*.jar", "mods/my-mod.jar"));
        assert!(!glob_match("mods/*.jar", "config/my-mod.jar"));
        assert!(glob_match("*.txt", "config/notes.txt"));
    }
}
