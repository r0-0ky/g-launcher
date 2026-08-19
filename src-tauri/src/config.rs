use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::util::{read_json, write_json};

pub const DEFAULT_MANIFEST_URL: &str = "https://onlyg.land/manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// URL манифеста с режимами.
    pub manifest_url: String,
    /// Куда складывать игру. Пусто — папка данных приложения.
    pub root_dir: Option<String>,
    pub memory_mb: u32,
    /// Явный путь к java. Пусто — лаунчер скачает нужную сам.
    pub java_path: Option<String>,
    pub jvm_args: String,
    /// client_id приложения Azure для входа через Microsoft.
    pub ms_client_id: String,
    pub fullscreen: bool,
    pub close_launcher_on_start: bool,
    /// Сразу подключаться к серверу режима при запуске.
    pub auto_connect: bool,
    pub last_mode: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            manifest_url: DEFAULT_MANIFEST_URL.to_string(),
            root_dir: None,
            memory_mb: 4096,
            java_path: None,
            jvm_args: "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 \
                       -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M"
                .to_string(),
            ms_client_id: String::new(),
            fullscreen: false,
            close_launcher_on_start: false,
            auto_connect: true,
            last_mode: None,
        }
    }
}

/// Client ID приложения Azure, зашитый в бинарь на сборке.
/// Задаётся через `GANDONI_MS_CLIENT_ID` при `cargo build` / `tauri build`.
pub const BUILTIN_MS_CLIENT_ID: Option<&str> = option_env!("GANDONI_MS_CLIENT_ID");

impl Settings {
    /// Итоговый Client ID для входа через Microsoft. Приоритет:
    /// 1) значение из настроек пользователя (если задал своё);
    /// 2) переменная окружения при запуске (удобно для отладки);
    /// 3) значение, зашитое в бинарь на сборке — один на всех пользователей.
    pub fn effective_ms_client_id(&self) -> String {
        let from_settings = self.ms_client_id.trim();
        if !from_settings.is_empty() {
            return from_settings.to_string();
        }
        if let Ok(value) = std::env::var("GANDONI_MS_CLIENT_ID") {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
        BUILTIN_MS_CLIENT_ID.unwrap_or("").trim().to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    Offline,
    Microsoft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub kind: AccountKind,
    pub username: String,
    pub uuid: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix-время в секундах, когда протухает access_token.
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub xuid: Option<String>,
}

impl Account {
    pub fn offline(username: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: AccountKind::Offline,
            username: username.to_string(),
            uuid: crate::util::offline_uuid(username),
            access_token: "0".to_string(),
            refresh_token: None,
            expires_at: 0,
            xuid: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub settings: Settings,
    pub accounts: Vec<Account>,
    pub active_account: Option<String>,
}

impl Store {
    pub fn load(path: &Path) -> Self {
        read_json(path).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_json(path, self)
    }

    pub fn active(&self) -> Option<&Account> {
        let id = self.active_account.as_ref()?;
        self.accounts.iter().find(|a| &a.id == id)
    }
}

/// Раскладка папок на диске.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Корень с общими данными игры.
    pub root: PathBuf,
}

impl Paths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn assets(&self) -> PathBuf {
        self.root.join("assets")
    }
    pub fn libraries(&self) -> PathBuf {
        self.root.join("libraries")
    }
    pub fn versions(&self) -> PathBuf {
        self.root.join("versions")
    }
    pub fn version_dir(&self, id: &str) -> PathBuf {
        self.versions().join(id)
    }
    pub fn version_json(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.json"))
    }
    pub fn version_jar(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.jar"))
    }
    pub fn natives(&self, id: &str) -> PathBuf {
        self.version_dir(id).join("natives")
    }
    pub fn java_dir(&self) -> PathBuf {
        self.root.join("java")
    }
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }
    /// Игровая папка конкретного режима — отдельная для каждого.
    pub fn instance(&self, mode_id: &str) -> PathBuf {
        self.root.join("instances").join(mode_id)
    }
    pub fn instance_state(&self, mode_id: &str) -> PathBuf {
        self.instance(mode_id).join(".gandoni-state.json")
    }
}
