use std::collections::HashMap;
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::Deserialize;

use crate::config::Paths;
use crate::download::{download_all, get_json, Task};
use crate::error::{Error, Result};
use crate::progress::Progress;
use crate::util::java_os_key;

const RUNTIME_MANIFEST: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

type AllRuntimes = HashMap<String, HashMap<String, Vec<RuntimeEntry>>>;

#[derive(Debug, Deserialize)]
struct RuntimeEntry {
    manifest: RuntimeManifestRef,
}

#[derive(Debug, Deserialize)]
struct RuntimeManifestRef {
    url: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeFiles {
    files: HashMap<String, RuntimeFile>,
}

#[derive(Debug, Deserialize)]
struct RuntimeFile {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    downloads: HashMap<String, RuntimeDownload>,
    #[serde(default)]
    target: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeDownload {
    url: String,
    sha1: String,
    size: u64,
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "javaw.exe"
    } else {
        "java"
    }
}

/// Ищет исполняемый файл java внутри распакованной среды выполнения.
fn find_binary(dir: &Path) -> Option<PathBuf> {
    let candidates = [
        dir.join("bin").join(binary_name()),
        dir.join("jre.bundle/Contents/Home/bin").join(binary_name()),
        dir.join("Contents/Home/bin").join(binary_name()),
    ];
    candidates.into_iter().find(|path| path.exists())
}

/// Чем спрашивать версию: `javaw.exe` окна не открывает, но и в перехваченный
/// вывод не пишет — про версию спрашиваем консольную java рядом с ним.
fn probe_binary(binary: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        let console = binary.with_file_name("java.exe");
        if console.exists() {
            return console;
        }
    }
    binary.to_path_buf()
}

/// Запускается ли эта среда вообще.
///
/// Наличия `bin/java` мало: если загрузка оборвалась после него, рядом не будет
/// `lib/modules`, и такая java падает ещё до первой строки кода — «Failed
/// setting boot class path». Спрашиваем версию: ответила — среда цела.
fn runtime_works(binary: &Path) -> bool {
    probe_major_version(&probe_binary(binary)).is_some()
}

/// Скачивает среду выполнения нужной версии от Mojang (компоненты вида `java-runtime-gamma`).
pub async fn ensure_runtime(
    client: &Client,
    paths: &Paths,
    component: &str,
    progress: &Progress,
) -> Result<PathBuf> {
    let os_key = java_os_key();
    let target_dir = paths.java_dir().join(os_key).join(component);

    if let Some(binary) = find_binary(&target_dir) {
        if runtime_works(&binary) {
            return Ok(binary);
        }
        // Среда недокачана: раньше мы возвращали её как есть, и игрок навсегда
        // застревал на «Failed setting boot class path» — недостающие файлы уже
        // никто не запрашивал. Идём за списком заново, докачается нехватка.
        progress.stage("Java", "Среда выполнения повреждена — докачиваем");
    }

    progress.stage("Java", &format!("Загружаем среду выполнения {component}"));

    let all: AllRuntimes = get_json(client, RUNTIME_MANIFEST).await?;
    let entry = all
        .get(os_key)
        .and_then(|components| components.get(component))
        .and_then(|entries| entries.first())
        .ok_or_else(|| {
            Error::msg(format!(
                "Mojang не раздаёт {component} для {os_key}; укажите путь к Java в настройках"
            ))
        })?;

    let files: RuntimeFiles = get_json(client, &entry.manifest.url).await?;

    let mut tasks = Vec::new();
    let mut links: Vec<(PathBuf, String)> = Vec::new();

    for (rel_path, file) in &files.files {
        let dest = target_dir.join(rel_path);
        match file.kind.as_str() {
            "directory" => {
                std::fs::create_dir_all(&dest)?;
            }
            "link" => {
                if let Some(target) = &file.target {
                    links.push((dest, target.clone()));
                }
            }
            _ => {
                if let Some(download) = file.downloads.get("raw") {
                    tasks.push(
                        Task::new(download.url.clone(), dest)
                            .with_hash(Some(download.sha1.clone()), Some(download.size))
                            .executable(file.executable),
                    );
                }
            }
        }
    }

    download_all(client, tasks, 12, false, progress).await?;

    for (path, target) in links {
        if path.exists() {
            continue;
        }
        crate::util::ensure_parent(&path)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &path)?;
        #[cfg(windows)]
        {
            // На Windows симлинки требуют прав, поэтому просто копируем цель.
            if let Some(parent) = path.parent() {
                let source = parent.join(&target);
                if source.exists() {
                    let _ = std::fs::copy(source, &path);
                }
            }
        }
    }

    let binary = find_binary(&target_dir).ok_or_else(|| {
        Error::msg(format!(
            "не нашли исполняемый файл java в {}",
            target_dir.display()
        ))
    })?;

    // Докачали, но среда всё равно не стартует — честно скажем об этом здесь,
    // иначе игрок увидит невнятную ошибку виртуальной машины на установке
    // режима. Наверху есть запасной путь: системная Java.
    if !runtime_works(&binary) {
        return Err(Error::msg(format!(
            "среда выполнения {component} не запускается; удалите {} и повторите",
            target_dir.display()
        )));
    }

    Ok(binary)
}

/// Мажорная версия java по выводу `java -version`.
pub fn probe_major_version(java: &Path) -> Option<u32> {
    let mut command = std::process::Command::new(java);
    command.arg("-version");

    #[cfg(windows)]
    {
        // Иначе на каждую проверку мигает чёрное окно консоли.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = command.output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let quoted = text.split('"').nth(1)?;
    let mut parts = quoted.split('.');
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

/// Java из PATH, если она подходит по версии.
pub fn system_java(required_major: u32) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
        vec![PathBuf::from("javaw.exe"), PathBuf::from("java.exe")]
    } else {
        vec![
            PathBuf::from("/usr/bin/java"),
            PathBuf::from("java"),
        ]
    };
    for candidate in candidates {
        if let Some(major) = probe_major_version(&candidate) {
            if major >= required_major {
                return Some(candidate);
            }
        }
    }
    None
}

/// Итоговый выбор java: настройка пользователя -> среда от Mojang -> системная.
pub async fn resolve(
    client: &Client,
    paths: &Paths,
    user_path: Option<&str>,
    component: Option<&str>,
    required_major: u32,
    progress: &Progress,
) -> Result<PathBuf> {
    if let Some(path) = user_path {
        if !path.trim().is_empty() {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
            return Err(Error::msg(format!(
                "указанный в настройках путь к Java не существует: {}",
                path.display()
            )));
        }
    }

    let component = component.unwrap_or(match required_major {
        0..=8 => "jre-legacy",
        9..=16 => "java-runtime-alpha",
        17..=20 => "java-runtime-gamma",
        _ => "java-runtime-delta",
    });

    match ensure_runtime(client, paths, component, progress).await {
        Ok(path) => Ok(path),
        Err(err) => system_java(required_major).ok_or_else(|| {
            Error::msg(format!(
                "не удалось получить Java {required_major}: {err}. \
                 Установите Java {required_major} и укажите путь в настройках."
            ))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Кладёт в `dir/bin` подставную java из shell-скрипта.
    #[cfg(unix)]
    fn fake_java(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.join("java");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// Обрубок среды: файл на месте, но виртуальная машина не поднимается.
    /// Раньше такую java лаунчер отдавал как готовую, и установка режима падала
    /// на «Failed setting boot class path» до самого удаления папки вручную.
    #[cfg(unix)]
    #[test]
    fn broken_runtime_is_not_accepted() {
        let dir = std::env::temp_dir().join(format!("gandoni-java-{}", uuid::Uuid::new_v4()));
        let java = fake_java(
            &dir,
            "echo 'Error occurred during initialization of VM' >&2\n\
             echo 'Failed setting boot class path.' >&2\nexit 1",
        );

        assert!(find_binary(&dir).is_some(), "исполняемый файл на месте");
        assert!(!runtime_works(&java), "но средой такое считать нельзя");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn healthy_runtime_reports_its_version() {
        let dir = std::env::temp_dir().join(format!("gandoni-java-{}", uuid::Uuid::new_v4()));
        let java = fake_java(&dir, "echo 'openjdk version \"21.0.3\" 2024-04-16' >&2");

        assert!(runtime_works(&java));
        assert_eq!(probe_major_version(&java), Some(21));

        std::fs::remove_dir_all(&dir).ok();
    }
}
