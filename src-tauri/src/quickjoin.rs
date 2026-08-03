use std::path::Path;

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::config::Paths;
use crate::error::Result;
use crate::manifest::{LoaderKind, Mode};
use crate::util::sha1_file;

const CONFIG_NAME: &str = "gandoni-quickjoin.json";
const MOD_PREFIX: &str = "gandoni-quickjoin";

/// Кнопку в меню умеют показывать только Fabric и Quilt (мод под них).
fn loader_supported(mode: &Mode) -> bool {
    matches!(mode.loader.kind, LoaderKind::Fabric | LoaderKind::Quilt)
}

/// Пишет адрес сервера режима в config/gandoni-quickjoin.json —
/// оттуда его читает мод и рисует кнопку в главном меню.
pub fn write_config(paths: &Paths, mode: &Mode) -> Result<()> {
    let config_path = paths.instance(&mode.id).join("config").join(CONFIG_NAME);

    // Нет сервера или лоадер без мода — конфиг не нужен, старый убираем.
    let Some(server) = mode.server.as_ref().filter(|_| loader_supported(mode)) else {
        if config_path.exists() {
            let _ = std::fs::remove_file(&config_path);
        }
        return Ok(());
    };

    let payload = json!({
        "host": server.host,
        "port": server.port,
        "label": mode.name,
    });

    crate::util::ensure_parent(&config_path)?;
    std::fs::write(&config_path, serde_json::to_vec_pretty(&payload)?)?;
    Ok(())
}

/// Кладёт мод из ресурсов приложения в mods/ сборки, если его там ещё нет
/// (или он устарел). Мод берётся под версию Minecraft режима.
///
/// Файлы ресурсов: `resources/quickjoin/gandoni-quickjoin-<mcversion>.jar`.
/// Если под нужную версию мода нет — тихо пропускаем, кнопки просто не будет.
pub fn inject_mod(app: &AppHandle, paths: &Paths, mode: &Mode) -> Result<()> {
    if !loader_supported(mode) || mode.server.is_none() {
        return Ok(());
    }

    let resource_rel = format!("resources/quickjoin/{MOD_PREFIX}-{}.jar", mode.minecraft);
    let Ok(source) = app.path().resolve(&resource_rel, tauri::path::BaseDirectory::Resource) else {
        return Ok(());
    };
    if !source.exists() {
        return Ok(());
    }

    let mods_dir = paths.instance(&mode.id).join("mods");
    std::fs::create_dir_all(&mods_dir)?;
    let dest = mods_dir.join(format!("{MOD_PREFIX}-{}.jar", mode.minecraft));

    // Уже стоит и совпадает по содержимому — ничего не делаем.
    if dest.exists() {
        if let (Ok(a), Ok(b)) = (sha1_file(&source), sha1_file(&dest)) {
            if a.eq_ignore_ascii_case(&b) {
                return Ok(());
            }
        }
    }

    remove_stale(&mods_dir, &dest);
    std::fs::copy(&source, &dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Loader, ServerInfo};

    fn fabric_mode_with_server() -> Mode {
        Mode {
            id: "survival".into(),
            name: "Выживание".into(),
            minecraft: "1.20.1".into(),
            loader: Loader { kind: LoaderKind::Fabric, version: None },
            server: Some(ServerInfo { host: "mc.example.com".into(), port: 25577 }),
            ..Default::default()
        }
    }

    #[test]
    fn writes_config_for_fabric_server_mode() {
        let dir = std::env::temp_dir().join(format!("gandoni-qj-{}", uuid::Uuid::new_v4()));
        let paths = Paths::new(dir.clone());
        let mode = fabric_mode_with_server();

        write_config(&paths, &mode).unwrap();

        let file = paths.instance("survival").join("config").join(CONFIG_NAME);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(json["host"], "mc.example.com");
        assert_eq!(json["port"], 25577);
        assert_eq!(json["label"], "Выживание");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_and_cleans_when_no_server() {
        let dir = std::env::temp_dir().join(format!("gandoni-qj-{}", uuid::Uuid::new_v4()));
        let paths = Paths::new(dir.clone());
        let mut mode = fabric_mode_with_server();

        // Сначала записали конфиг…
        write_config(&paths, &mode).unwrap();
        let file = paths.instance("survival").join("config").join(CONFIG_NAME);
        assert!(file.exists());

        // …потом у режима убрали сервер — конфиг должен исчезнуть.
        mode.server = None;
        write_config(&paths, &mode).unwrap();
        assert!(!file.exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_config_for_forge_loader() {
        let dir = std::env::temp_dir().join(format!("gandoni-qj-{}", uuid::Uuid::new_v4()));
        let paths = Paths::new(dir.clone());
        let mut mode = fabric_mode_with_server();
        mode.loader.kind = LoaderKind::Forge;

        write_config(&paths, &mode).unwrap();
        let file = paths.instance("survival").join("config").join(CONFIG_NAME);
        assert!(!file.exists(), "для Forge мода нет — конфиг не нужен");

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Убирает прежние версии мода (после смены версии игры в режиме).
fn remove_stale(mods_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(mods_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let is_our_mod = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(MOD_PREFIX))
            .unwrap_or(false);
        if is_our_mod {
            let _ = std::fs::remove_file(&path);
        }
    }
}
