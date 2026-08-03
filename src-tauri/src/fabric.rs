use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::config::Paths;
use crate::download::get_json;
use crate::error::{Error, Result};
use crate::util::write_json;

const META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";

#[derive(Debug, Deserialize)]
struct LoaderEntry {
    loader: LoaderInfo,
}

#[derive(Debug, Deserialize)]
struct LoaderInfo {
    version: String,
    #[serde(default)]
    stable: bool,
}

fn base_url(quilt: bool) -> &'static str {
    if quilt {
        QUILT_META
    } else {
        META
    }
}

/// Последняя стабильная версия лоадера для указанной версии игры.
pub async fn latest_loader(client: &Client, mc_version: &str, quilt: bool) -> Result<String> {
    let url = format!("{}/versions/loader/{mc_version}", base_url(quilt));
    let entries: Vec<LoaderEntry> = get_json(client, &url).await?;
    let stable = entries.iter().find(|e| e.loader.stable);
    let chosen = stable
        .or_else(|| entries.first())
        .ok_or_else(|| Error::msg(format!("для {mc_version} нет версий Fabric")))?;
    Ok(chosen.loader.version.clone())
}

/// Кладёт профиль лоадера в versions/ и возвращает id версии для запуска.
pub async fn install(
    client: &Client,
    paths: &Paths,
    mc_version: &str,
    loader_version: Option<&str>,
    quilt: bool,
) -> Result<String> {
    let loader_version = match loader_version {
        Some(version) if !version.is_empty() && version != "latest" => version.to_string(),
        _ => latest_loader(client, mc_version, quilt).await?,
    };

    let url = format!(
        "{}/versions/loader/{mc_version}/{loader_version}/profile/json",
        base_url(quilt)
    );
    let profile: Value = get_json(client, &url).await?;
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("профиль Fabric без поля id"))?
        .to_string();

    write_json(&paths.version_json(&id), &profile)?;
    Ok(id)
}
