use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("файловая ошибка: {0}")]
    Io(#[from] std::io::Error),
    #[error("сеть: {0}")]
    Http(#[from] reqwest::Error),
    #[error("не удалось разобрать JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("архив: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Msg(String),
}

impl Error {
    pub fn msg(text: impl Into<String>) -> Self {
        Error::Msg(text.into())
    }
}

/// Ошибки уезжают во фронтенд обычной строкой — там они показываются как есть.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
