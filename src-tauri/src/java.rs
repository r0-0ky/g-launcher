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
        return Ok(binary);
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

    find_binary(&target_dir).ok_or_else(|| {
        Error::msg(format!(
            "не нашли исполняемый файл java в {}",
            target_dir.display()
        ))
    })
}

/// Мажорная версия java по выводу `java -version`.
pub fn probe_major_version(java: &Path) -> Option<u32> {
    let output = std::process::Command::new(java).arg("-version").output().ok()?;
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
