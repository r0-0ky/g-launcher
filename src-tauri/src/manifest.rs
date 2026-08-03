use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderKind {
    Vanilla,
    Fabric,
    Quilt,
    Forge,
    #[serde(alias = "neo", alias = "neoforged")]
    Neoforge,
}

impl Default for LoaderKind {
    fn default() -> Self {
        LoaderKind::Vanilla
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Loader {
    #[serde(rename = "type")]
    pub kind: LoaderKind,
    /// Пусто или `latest` — возьмём свежую версию лоадера.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeFile {
    pub path: String,
    pub url: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    /// Необязательный файл: ставим один раз, при удалении игроком не возвращаем.
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaRequirement {
    pub major: u32,
    /// Компонент среды выполнения Mojang, если нужен конкретный.
    pub component: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    25565
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    pub min: Option<u32>,
    pub max: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mode {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Версия сборки — показывается в интерфейсе.
    pub version: Option<String>,
    pub icon: Option<String>,
    pub banner: Option<String>,
    pub minecraft: String,
    pub loader: Loader,
    pub java: Option<JavaRequirement>,
    pub memory: Memory,
    pub server: Option<ServerInfo>,
    pub files: Vec<ModeFile>,
    /// Папки, которыми управляет лаунчер: лишние файлы в них удаляются.
    pub sync_paths: Vec<String>,
    /// Что не трогать при очистке (поддерживается `*`).
    pub keep: Vec<String>,
    pub jvm_args: Option<String>,
}

impl Mode {
    /// По умолчанию под полным контролем моды и конфиги.
    pub fn managed_dirs(&self) -> Vec<String> {
        if self.sync_paths.is_empty() {
            vec!["mods".to_string()]
        } else {
            self.sync_paths.clone()
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Manifest {
    pub schema: u32,
    pub updated: Option<String>,
    pub news: Option<String>,
    pub modes: Vec<Mode>,
}

impl Manifest {
    pub fn mode(&self, id: &str) -> Result<&Mode> {
        self.modes
            .iter()
            .find(|mode| mode.id == id)
            .ok_or_else(|| Error::msg(format!("режим «{id}» не найден в манифесте")))
    }

    pub fn validate(&self) -> Result<()> {
        if self.modes.is_empty() {
            return Err(Error::msg("в манифесте нет ни одного режима"));
        }
        for mode in &self.modes {
            if mode.id.is_empty() {
                return Err(Error::msg("у режима не заполнен id"));
            }
            if mode.id.contains(['/', '\\', ':']) {
                return Err(Error::msg(format!("недопустимый id режима: {}", mode.id)));
            }
            if mode.minecraft.is_empty() {
                return Err(Error::msg(format!(
                    "у режима «{}» не указана версия Minecraft",
                    mode.id
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Манифест, который отдаёт бэкенд (server/), должен без потерь читаться лаунчером.
    #[test]
    fn parses_backend_manifest() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/server-manifest-sample.json");
        let Ok(data) = std::fs::read(path) else {
            return; // образец кладётся во время интеграционной проверки
        };
        let manifest: Manifest = serde_json::from_slice(&data).expect("манифест не разобрался");
        manifest.validate().expect("манифест не прошёл валидацию");
        let mode = &manifest.modes[0];
        assert_eq!(mode.loader.kind, LoaderKind::Fabric);
        assert!(mode.server.is_some());
        assert!(mode.files.iter().all(|f| !f.url.is_empty() && f.sha1.is_some()));
    }
}
