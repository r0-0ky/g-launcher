use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT_PROGRESS: &str = "install://progress";
pub const EVENT_LOG: &str = "game://log";
pub const EVENT_GAME_STATE: &str = "game://state";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub mode: String,
    pub stage: String,
    pub message: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub percent: f32,
    pub done: bool,
}

/// Счётчик прогресса установки, который умеет слать события во фронтенд
/// не чаще, чем раз в 80 мс — иначе UI захлёбывается на тысячах ассетов.
#[derive(Clone)]
pub struct Progress {
    /// `None` — режим без интерфейса (тесты, фоновые задачи).
    app: Option<AppHandle>,
    mode: String,
    stage: Arc<Mutex<String>>,
    message: Arc<Mutex<String>>,
    bytes_done: Arc<AtomicU64>,
    bytes_total: Arc<AtomicU64>,
    files_done: Arc<AtomicU64>,
    files_total: Arc<AtomicU64>,
    last_emit: Arc<Mutex<Instant>>,
}

impl Progress {
    pub fn new(app: AppHandle, mode: impl Into<String>) -> Self {
        Self::build(Some(app), mode)
    }

    /// Счётчик, который никуда не шлёт события.
    #[cfg(test)]
    pub fn silent(mode: impl Into<String>) -> Self {
        Self::build(None, mode)
    }

    fn build(app: Option<AppHandle>, mode: impl Into<String>) -> Self {
        Self {
            app,
            mode: mode.into(),
            stage: Arc::new(Mutex::new("Подготовка".into())),
            message: Arc::new(Mutex::new(String::new())),
            bytes_done: Arc::new(AtomicU64::new(0)),
            bytes_total: Arc::new(AtomicU64::new(0)),
            files_done: Arc::new(AtomicU64::new(0)),
            files_total: Arc::new(AtomicU64::new(0)),
            last_emit: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))),
        }
    }

    /// Новый этап установки: счётчики обнуляются.
    pub fn stage(&self, stage: &str, message: &str) {
        *self.stage.lock().unwrap() = stage.to_string();
        *self.message.lock().unwrap() = message.to_string();
        self.bytes_done.store(0, Ordering::Relaxed);
        self.bytes_total.store(0, Ordering::Relaxed);
        self.files_done.store(0, Ordering::Relaxed);
        self.files_total.store(0, Ordering::Relaxed);
        self.emit(true);
    }

    pub fn message(&self, message: &str) {
        *self.message.lock().unwrap() = message.to_string();
        self.emit(true);
    }

    pub fn set_totals(&self, files: u64, bytes: u64) {
        self.files_total.store(files, Ordering::Relaxed);
        self.bytes_total.store(bytes, Ordering::Relaxed);
        self.emit(true);
    }

    pub fn add_bytes(&self, bytes: u64) {
        self.bytes_done.fetch_add(bytes, Ordering::Relaxed);
        self.emit(false);
    }

    pub fn file_done(&self) {
        self.files_done.fetch_add(1, Ordering::Relaxed);
        self.emit(false);
    }

    pub fn finish(&self, message: &str) {
        *self.stage.lock().unwrap() = "Готово".into();
        *self.message.lock().unwrap() = message.to_string();
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT_PROGRESS, self.payload(true));
        }
    }

    fn payload(&self, done: bool) -> ProgressPayload {
        let bytes_done = self.bytes_done.load(Ordering::Relaxed);
        let bytes_total = self.bytes_total.load(Ordering::Relaxed);
        let files_done = self.files_done.load(Ordering::Relaxed);
        let files_total = self.files_total.load(Ordering::Relaxed);

        // По байтам точнее, но пока не известен полный размер — считаем по файлам.
        let percent = if bytes_total > 0 {
            (bytes_done as f32 / bytes_total as f32) * 100.0
        } else if files_total > 0 {
            (files_done as f32 / files_total as f32) * 100.0
        } else {
            0.0
        };

        ProgressPayload {
            mode: self.mode.clone(),
            stage: self.stage.lock().unwrap().clone(),
            message: self.message.lock().unwrap().clone(),
            bytes_done,
            bytes_total,
            files_done,
            files_total,
            percent: percent.clamp(0.0, 100.0),
            done,
        }
    }

    fn emit(&self, force: bool) {
        let Some(app) = &self.app else {
            return;
        };
        {
            let mut last = self.last_emit.lock().unwrap();
            if !force && last.elapsed() < Duration::from_millis(80) {
                return;
            }
            *last = Instant::now();
        }
        let _ = app.emit(EVENT_PROGRESS, self.payload(false));
    }
}
