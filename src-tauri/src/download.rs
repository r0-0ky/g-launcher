use std::path::{Path, PathBuf};

use futures::stream::StreamExt;
use reqwest::Client;
use tokio::io::AsyncWriteExt;

use crate::error::{Error, Result};
use crate::progress::Progress;
use crate::util::{ensure_parent, sha1_file};

#[derive(Debug, Clone)]
pub struct Task {
    pub url: String,
    pub dest: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub executable: bool,
}

impl Task {
    pub fn new(url: impl Into<String>, dest: PathBuf) -> Self {
        Self {
            url: url.into(),
            dest,
            sha1: None,
            size: None,
            executable: false,
        }
    }

    pub fn with_hash(mut self, sha1: Option<String>, size: Option<u64>) -> Self {
        self.sha1 = sha1;
        self.size = size;
        self
    }

    pub fn executable(mut self, value: bool) -> Self {
        self.executable = value;
        self
    }
}

/// Нужен ли файл заново. Полная проверка sha1 только когда просят `verify`:
/// хэшировать все 4000 ассетов на каждый запуск слишком дорого.
pub fn needs_download(task: &Task, verify: bool) -> bool {
    let meta = match std::fs::metadata(&task.dest) {
        Ok(meta) => meta,
        Err(_) => return true,
    };
    if !meta.is_file() {
        return true;
    }
    if let Some(size) = task.size {
        if meta.len() != size {
            return true;
        }
    } else if meta.len() == 0 {
        return true;
    }
    if verify {
        if let Some(expected) = &task.sha1 {
            match sha1_file(&task.dest) {
                Ok(actual) => return !actual.eq_ignore_ascii_case(expected),
                Err(_) => return true,
            }
        }
    }
    false
}

/// Скачивает список файлов в несколько потоков, обновляя прогресс.
pub async fn download_all(
    client: &Client,
    tasks: Vec<Task>,
    concurrency: usize,
    verify: bool,
    progress: &Progress,
) -> Result<u64> {
    let pending: Vec<Task> = tasks
        .into_iter()
        .filter(|task| needs_download(task, verify))
        .collect();

    if pending.is_empty() {
        return Ok(0);
    }

    let total_bytes: u64 = pending.iter().filter_map(|t| t.size).sum();
    progress.set_totals(pending.len() as u64, total_bytes);
    let downloaded = pending.len() as u64;

    let results = futures::stream::iter(pending.into_iter().map(|task| {
        let client = client.clone();
        let progress = progress.clone();
        async move {
            let result = download_one(&client, &task, &progress).await;
            progress.file_done();
            result.map_err(|err| Error::msg(format!("{}: {err}", task.url)))
        }
    }))
    .buffer_unordered(concurrency.max(1))
    .collect::<Vec<_>>()
    .await;

    for result in results {
        result?;
    }
    Ok(downloaded)
}

async fn download_one(client: &Client, task: &Task, progress: &Progress) -> Result<()> {
    let mut last_error: Option<Error> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(400 * attempt as u64)).await;
        }
        match try_download(client, task, progress).await {
            Ok(()) => return Ok(()),
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| Error::msg("не удалось скачать файл")))
}

async fn try_download(client: &Client, task: &Task, progress: &Progress) -> Result<()> {
    ensure_parent(&task.dest)?;
    let tmp = task.dest.with_extension("part");

    let response = client.get(&task.url).send().await?;
    if !response.status().is_success() {
        return Err(Error::msg(format!("сервер ответил {}", response.status())));
    }

    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        progress.add_bytes(chunk.len() as u64);
    }
    file.flush().await?;
    drop(file);

    if let Some(expected) = &task.sha1 {
        let actual = sha1_file(&tmp)?;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::msg(format!(
                "хэш не совпал (ожидали {expected}, получили {actual})"
            )));
        }
    }

    if task.dest.exists() {
        std::fs::remove_file(&task.dest)?;
    }
    std::fs::rename(&tmp, &task.dest)?;

    if task.executable {
        set_executable(&task.dest)?;
    }
    Ok(())
}

pub fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(path, perms)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub async fn get_json<T: serde::de::DeserializeOwned>(client: &Client, url: &str) -> Result<T> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(Error::msg(format!(
            "{url} ответил {}",
            response.status()
        )));
    }
    let bytes = response.bytes().await?;
    serde_json::from_slice(&bytes).map_err(|err| Error::msg(format!("{url}: {err}")))
}

pub async fn get_bytes(client: &Client, url: &str) -> Result<Vec<u8>> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(Error::msg(format!("{url} ответил {}", response.status())));
    }
    Ok(response.bytes().await?.to_vec())
}
