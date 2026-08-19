use std::path::{Path, PathBuf};

use reqwest::Client;
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

use crate::config::{Account, AccountKind};
use crate::error::{Error, Result};

/// Вход через наш сервер: игрок подтверждает себя в Telegram, а игра потом
/// ходит к нам вместо серверов Mojang.
///
/// Адрес сервера не спрашиваем отдельно — берём его из адреса манифеста: и то,
/// и другое отдаёт один и тот же сервер.

/// Из `https://onlyg.land/manifest.json` получаем `https://onlyg.land`.
pub fn base_from_manifest(manifest_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(manifest_url).map_err(|_| {
        Error::msg("вход через G Land работает, только когда манифест берётся по http-адресу")
    })?;
    let host = parsed
        .host_str()
        .ok_or_else(|| Error::msg("в адресе манифеста нет хоста"))?;

    Ok(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    /// Одноразовый код: по нему опрашиваем сервер и его же кладём в ссылку.
    pub token: String,
    /// Ссылка на бота — её открываем в браузере.
    pub url: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub username: Option<String>,
    #[serde(default)]
    pub skin_model: String,
    #[serde(default)]
    pub has_skin: bool,
    /// Картинка предмета вместо аватарки.
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    status: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    profile: Option<Profile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    profile: GameProfile,
}

#[derive(Debug, Deserialize)]
struct GameProfile {
    id: String,
    name: String,
}

async fn fail(response: reqwest::Response) -> Error {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    // Сервер отвечает JSON-ом с полем error — достаём человеческий текст.
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("errorMessage"))
                .and_then(|e| e.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| format!("сервер ответил {status}"));
    Error::msg(message)
}

/// Шаг 1: просим ссылку на бота.
pub async fn start_login(client: &Client, base: &str) -> Result<LoginStart> {
    let response = client.post(format!("{base}/api/auth/start")).send().await?;
    if !response.status().is_success() {
        return Err(fail(response).await);
    }
    Ok(response.json().await?)
}

/// Шаг 2: спрашиваем, нажали ли кнопку. `None` — ещё нет.
pub async fn poll_login(
    client: &Client,
    base: &str,
    token: &str,
) -> Result<Option<(String, Profile)>> {
    let response = client
        .get(format!("{base}/api/auth/status"))
        .query(&[("token", token)])
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(fail(response).await);
    }

    let body: StatusResponse = response.json().await?;
    if body.status != "ready" {
        return Ok(None);
    }

    match (body.session, body.profile) {
        (Some(session), Some(profile)) => Ok(Some((session, profile))),
        _ => Err(Error::msg("сервер не вернул сессию")),
    }
}

pub async fn fetch_profile(client: &Client, base: &str, session: &str) -> Result<Profile> {
    let response = client
        .get(format!("{base}/api/me"))
        .bearer_auth(session)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(fail(response).await);
    }
    Ok(response.json().await?)
}

/// Ник игрок меняет сам — UUID при этом остаётся прежним.
pub async fn set_nickname(
    client: &Client,
    base: &str,
    session: &str,
    username: &str,
) -> Result<Profile> {
    let response = client
        .post(format!("{base}/api/me/nickname"))
        .bearer_auth(session)
        .json(&serde_json::json!({ "username": username }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(fail(response).await);
    }
    Ok(response.json().await?)
}

/// Перед запуском игры меняем сессию лаунчера на токен, который понимает игра.
pub async fn game_token(client: &Client, base: &str, session: &str) -> Result<Account> {
    let response = client
        .post(format!("{base}/auth/token"))
        .bearer_auth(session)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(fail(response).await);
    }

    let body: TokenResponse = response.json().await?;
    Ok(Account {
        id: String::new(),
        kind: AccountKind::GLand,
        username: body.profile.name,
        uuid: body.profile.id,
        access_token: body.access_token,
        refresh_token: None,
        expires_at: 0,
        xuid: None,
        session: Some(session.to_string()),
        avatar: None,
    })
}

/// Скин или плащ из библиотеки игрока.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Texture {
    pub id: i64,
    pub kind: String,
    pub model: String,
    /// Адрес картинки — по нему интерфейс показывает превью.
    pub url: String,
    /// Надета ли она сейчас.
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub profile: Profile,
    pub skins: Vec<Texture>,
    pub capes: Vec<Texture>,
}

async fn library(response: reqwest::Response) -> Result<Library> {
    if !response.status().is_success() {
        return Err(fail(response).await);
    }
    Ok(response.json().await?)
}

pub async fn textures(client: &Client, base: &str, session: &str) -> Result<Library> {
    library(
        client
            .get(format!("{base}/api/me/textures"))
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

/// Заливает файл с диска. Он попадает в библиотеку и сразу надевается.
pub async fn upload_texture(
    client: &Client,
    base: &str,
    session: &str,
    path: &Path,
    kind: &str,
    model: &str,
) -> Result<Library> {
    let data = tokio::fs::read(path).await?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "texture.png".to_string());

    let part = reqwest::multipart::Part::bytes(data)
        .file_name(name)
        .mime_str("image/png")?;
    let form = reqwest::multipart::Form::new().part("file", part);

    library(
        client
            .post(format!("{base}/api/me/textures"))
            .query(&[("kind", kind), ("model", model)])
            .bearer_auth(session)
            .multipart(form)
            .send()
            .await?,
    )
    .await
}

/// Тонкие руки или обычные у надетого скина.
pub async fn set_model(client: &Client, base: &str, session: &str, model: &str) -> Result<Library> {
    library(
        client
            .post(format!("{base}/api/me/textures/model"))
            .query(&[("model", model)])
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

pub async fn select_texture(client: &Client, base: &str, session: &str, id: i64) -> Result<Library> {
    library(
        client
            .post(format!("{base}/api/me/textures/{id}/select"))
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

/// Снять надетое, ничего не удаляя.
pub async fn clear_texture(client: &Client, base: &str, session: &str, kind: &str) -> Result<Library> {
    library(
        client
            .post(format!("{base}/api/me/textures/clear"))
            .query(&[("kind", kind)])
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

pub async fn delete_texture(client: &Client, base: &str, session: &str, id: i64) -> Result<Library> {
    library(
        client
            .delete(format!("{base}/api/me/textures/{id}"))
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

/// Вещь на витрине магазина.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopItem {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub price: i64,
    pub model: String,
    /// Качество: зелёное, синее, фиолетовое или легендарное.
    pub rarity: String,
    pub url: String,
    /// Уже куплено — покупать второй раз нечего.
    pub owned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shop {
    pub coins: i64,
    pub items: Vec<ShopItem>,
}

pub async fn shop(client: &Client, base: &str, session: &str) -> Result<Shop> {
    let response = client
        .get(format!("{base}/api/me/shop"))
        .bearer_auth(session)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(fail(response).await);
    }
    Ok(response.json().await?)
}

/// Покупка. В ответе — обновлённая библиотека: вещь сразу можно надеть.
pub async fn buy(client: &Client, base: &str, session: &str, id: i64) -> Result<Library> {
    library(
        client
            .post(format!("{base}/api/me/shop/{id}/buy"))
            .bearer_auth(session)
            .send()
            .await?,
    )
    .await
}

/// Откуда берём authlib-injector: у проекта есть служебный адрес с последней
/// сборкой и её контрольной суммой.
const AGENT_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";

#[derive(Debug, Deserialize)]
struct AgentArtifact {
    download_url: String,
    checksums: AgentChecksums,
}

#[derive(Debug, Deserialize)]
struct AgentChecksums {
    sha256: String,
}

/// Кладёт agent-jar рядом с игрой и возвращает путь. Уже скачанный не трогаем.
pub async fn ensure_agent(client: &Client, root: &Path) -> Result<PathBuf> {
    let dir = root.join("agents");
    let target = dir.join("authlib-injector.jar");
    if target.exists() {
        return Ok(target);
    }

    let artifact: AgentArtifact = client.get(AGENT_LATEST).send().await?.json().await?;
    let bytes = client
        .get(&artifact.download_url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    // Этот jar подсовывается в JVM агентом, поэтому качаем только со сверкой
    // контрольной суммы — иначе подмена файла по пути прошла бы незаметно.
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(artifact.checksums.sha256.trim()) {
        return Err(Error::msg(
            "контрольная сумма authlib-injector не совпала — файл не сохранён",
        ));
    }

    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(&target, &bytes).await?;
    Ok(target)
}

/// Аргумент JVM, который заворачивает обращения игры к Mojang на наш сервер.
pub fn agent_arg(agent: &Path, base: &str) -> String {
    format!("-javaagent:{}={}/auth", agent.display(), base)
}
