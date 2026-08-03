use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{Account, AccountKind};
use crate::error::{Error, Result};

const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const SCOPE: &str = "XboxLive.signin offline_access";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default = "default_interval")]
    interval: u64,
    #[serde(default)]
    expires_in: u64,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

fn require_client_id(client_id: &str) -> Result<()> {
    if client_id.trim().is_empty() {
        return Err(Error::msg(
            "не задан Client ID приложения Microsoft. Зарегистрируйте приложение в Azure \
             (Mobile and desktop applications, allow public client flows) и впишите его ID \
             в настройках лаунчера.",
        ));
    }
    Ok(())
}

/// Шаг 1: получаем код, который игрок вводит на сайте Microsoft.
pub async fn start_device_code(client: &Client, client_id: &str) -> Result<DeviceCode> {
    require_client_id(client_id)?;
    let response = client
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", client_id), ("scope", SCOPE)])
        .send()
        .await?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(Error::msg(format!("Microsoft отклонил запрос: {text}")));
    }

    let data: DeviceCodeResponse = response.json().await?;
    Ok(DeviceCode {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        interval: data.interval.max(1),
        expires_in: data.expires_in,
    })
}

/// Шаг 2: опрос статуса. `Ok(None)` — игрок ещё не подтвердил вход.
pub async fn poll_device_code(
    client: &Client,
    client_id: &str,
    device_code: &str,
) -> Result<Option<Account>> {
    require_client_id(client_id)?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id),
            ("device_code", device_code),
        ])
        .send()
        .await?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));

    if !status.is_success() {
        let error = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        return match error {
            "authorization_pending" | "slow_down" => Ok(None),
            "expired_token" => Err(Error::msg("время на подтверждение входа истекло")),
            "authorization_declined" => Err(Error::msg("вход отклонён")),
            other => Err(Error::msg(format!("ошибка входа Microsoft: {other}"))),
        };
    }

    let token: TokenResponse = serde_json::from_value(body)?;
    let account = complete_login(client, &token.access_token, token.refresh_token.clone()).await?;
    Ok(Some(account))
}

/// Обновляет протухший access_token по refresh_token.
pub async fn refresh(client: &Client, client_id: &str, account: &Account) -> Result<Account> {
    require_client_id(client_id)?;
    let refresh_token = account
        .refresh_token
        .clone()
        .ok_or_else(|| Error::msg("нет refresh-токена, войдите заново"))?;

    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token.as_str()),
            ("scope", SCOPE),
        ])
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(Error::msg("сессия Microsoft истекла, войдите заново"));
    }

    let token: TokenResponse = response.json().await?;
    let mut updated =
        complete_login(client, &token.access_token, token.refresh_token.clone()).await?;
    updated.id = account.id.clone();
    Ok(updated)
}

/// Xbox Live -> XSTS -> Minecraft services -> профиль.
async fn complete_login(
    client: &Client,
    ms_access_token: &str,
    refresh_token: Option<String>,
) -> Result<Account> {
    let xbl_response = client
        .post(XBL_URL)
        .json(&json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={ms_access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await?;

    let xbl_status = xbl_response.status();
    let xbl_body = xbl_response.text().await.unwrap_or_default();
    if !xbl_status.is_success() {
        return Err(Error::msg(format!(
            "Xbox Live отклонил вход ({xbl_status}). Ответ: {}",
            xbl_body.chars().take(300).collect::<String>()
        )));
    }
    let xbl: Value = serde_json::from_str(&xbl_body)
        .map_err(|err| Error::msg(format!("не удалось разобрать ответ Xbox Live: {err}")))?;

    let xbl_token = xbl
        .get("Token")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Xbox Live не выдал токен"))?;

    let xsts_response = client
        .post(XSTS_URL)
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await?;

    let xsts_status = xsts_response.status();
    let xsts: Value = xsts_response.json().await?;
    if !xsts_status.is_success() {
        let code = xsts.get("XErr").and_then(Value::as_u64).unwrap_or(0);
        let message = match code {
            2148916233 => "к этому аккаунту Microsoft не привязан профиль Xbox",
            2148916235 => "Xbox Live недоступен в вашем регионе",
            2148916238 => "детский аккаунт: нужно добавить его в семью Microsoft",
            _ => "не удалось авторизоваться в Xbox Live",
        };
        return Err(Error::msg(message));
    }

    let xsts_token = xsts
        .get("Token")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("XSTS не выдал токен"))?;
    let uhs = xsts
        .get("DisplayClaims")
        .and_then(|claims| claims.get("xui"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("uhs"))
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("XSTS не вернул uhs"))?;
    let xuid = xsts
        .get("DisplayClaims")
        .and_then(|claims| claims.get("xui"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("xid"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let mc_response = client
        .post(MC_LOGIN_URL)
        .json(&json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts_token}") }))
        .send()
        .await?;

    let mc_status = mc_response.status();
    let mc_body = mc_response.text().await.unwrap_or_default();
    if !mc_status.is_success() {
        return Err(Error::msg(format!(
            "Minecraft-сервис отклонил вход ({mc_status}). \
             Обычно это значит, что на аккаунте нет купленной Minecraft: Java Edition. \
             Ответ сервера: {}",
            mc_body.chars().take(300).collect::<String>()
        )));
    }

    let mc: Value = serde_json::from_str(&mc_body).map_err(|err| {
        Error::msg(format!("не удалось разобрать ответ Minecraft-сервиса: {err}"))
    })?;

    let mc_token = mc
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::msg(format!(
                "Minecraft не выдал токен доступа. Ответ: {}",
                mc_body.chars().take(300).collect::<String>()
            ))
        })?
        .to_string();
    let expires_in = mc.get("expires_in").and_then(Value::as_u64).unwrap_or(86400);

    let profile_response = client
        .get(MC_PROFILE_URL)
        .bearer_auth(&mc_token)
        .send()
        .await?;
    if profile_response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::msg(
            "на этом аккаунте нет купленной Minecraft: Java Edition",
        ));
    }
    let profile: Value = profile_response.json().await?;

    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("не удалось получить профиль Minecraft"))?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Player")
        .to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(Account {
        id: uuid::Uuid::new_v4().to_string(),
        kind: AccountKind::Microsoft,
        username: name,
        uuid: format_uuid(id),
        access_token: mc_token,
        refresh_token,
        expires_at: now + expires_in,
        xuid,
    })
}

/// Профиль отдаёт UUID без дефисов — приводим к каноническому виду.
fn format_uuid(raw: &str) -> String {
    if raw.len() != 32 {
        return raw.to_string();
    }
    format!(
        "{}-{}-{}-{}-{}",
        &raw[0..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..32]
    )
}
