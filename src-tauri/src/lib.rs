mod auth;
mod config;
mod download;
mod error;
mod gland;
mod fabric;
mod forge;
mod installer;
mod java;
mod launch;
mod manifest;
mod mojang;
mod progress;
mod quickjoin;
mod sync;
mod util;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::config::{Account, AccountKind, Paths, Settings, Store};
use crate::error::{Error, Result};
use crate::installer::UpdateReport;
use crate::manifest::Manifest;
use crate::progress::Progress;

pub struct AppState {
    client: Client,
    store: Mutex<Store>,
    manifest: Mutex<Option<Manifest>>,
    child: launch::SharedChild,
    default_root: PathBuf,
    config_file: PathBuf,
    busy: AtomicBool,
}

impl AppState {
    async fn paths(&self) -> Paths {
        let store = self.store.lock().await;
        let root = store
            .settings
            .root_dir
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_root.clone());
        Paths::new(root)
    }

    async fn settings(&self) -> Settings {
        self.store.lock().await.settings.clone()
    }

    async fn persist(&self) -> Result<()> {
        let store = self.store.lock().await;
        store.save(&self.config_file)
    }
}

/// Не даём запустить две установки одновременно.
struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            return Err(Error::msg("лаунчер уже занят другой задачей"));
        }
        Ok(Self(flag))
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    accounts: Vec<Account>,
    active_account: Option<String>,
    game_root: String,
    manifest: Option<Manifest>,
}

#[tauri::command]
async fn get_bootstrap(state: State<'_, AppState>) -> Result<Bootstrap> {
    let store = state.store.lock().await.clone();
    let paths = state.paths().await;
    let manifest = state.manifest.lock().await.clone();
    Ok(Bootstrap {
        settings: store.settings,
        accounts: store.accounts,
        active_account: store.active_account,
        game_root: paths.root.to_string_lossy().to_string(),
        manifest,
    })
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Bootstrap> {
    {
        let mut store = state.store.lock().await;
        store.settings = settings;
    }
    state.persist().await?;
    get_bootstrap(state).await
}

/// Тянет манифест режимов. Поддерживает и http(s), и локальный путь — удобно для отладки.
#[tauri::command]
async fn fetch_manifest(state: State<'_, AppState>, force: bool) -> Result<Manifest> {
    if !force {
        if let Some(cached) = state.manifest.lock().await.clone() {
            return Ok(cached);
        }
    }

    let url = state.settings().await.manifest_url;
    if url.trim().is_empty() {
        return Err(Error::msg("в настройках не указан адрес манифеста"));
    }

    let manifest: Manifest = if url.starts_with("http://") || url.starts_with("https://") {
        download::get_json(&state.client, &url).await?
    } else {
        let path = url.strip_prefix("file://").unwrap_or(&url);
        util::read_json(std::path::Path::new(path))
            .map_err(|err| Error::msg(format!("не удалось прочитать {path}: {err}")))?
    };

    manifest.validate()?;
    *state.manifest.lock().await = Some(manifest.clone());
    Ok(manifest)
}

async fn require_mode(state: &State<'_, AppState>, mode_id: &str) -> Result<manifest::Mode> {
    let cached = state.manifest.lock().await.clone();
    let manifest = match cached {
        Some(manifest) => manifest,
        None => fetch_manifest(state.clone(), false).await?,
    };
    manifest.mode(mode_id).cloned()
}

#[tauri::command]
async fn check_updates(
    state: State<'_, AppState>,
    mode_id: String,
    verify: bool,
) -> Result<UpdateReport> {
    let mode = require_mode(&state, &mode_id).await?;
    let paths = state.paths().await;
    installer::check_updates(&mode, &paths, verify)
}

#[tauri::command]
async fn install_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode_id: String,
    verify: bool,
) -> Result<()> {
    let _guard = BusyGuard::acquire(&state.busy)?;
    let mode = require_mode(&state, &mode_id).await?;
    let paths = state.paths().await;
    let settings = state.settings().await;
    let progress = Progress::new(app, mode_id.clone());

    installer::prepare(&state.client, &paths, &settings, &mode, verify, &progress).await?;
    Ok(())
}

/// Установить (если нужно) и сразу запустить игру.
#[tauri::command]
async fn play(
    app: AppHandle,
    state: State<'_, AppState>,
    mode_id: String,
    verify: bool,
) -> Result<()> {
    let _guard = BusyGuard::acquire(&state.busy)?;
    let mode = require_mode(&state, &mode_id).await?;
    let paths = state.paths().await;
    let settings = state.settings().await;

    let account = active_account(&state).await?;

    let progress = Progress::new(app.clone(), mode_id.clone());
    let prepared =
        installer::prepare(&state.client, &paths, &settings, &mode, verify, &progress).await?;

    // Кнопка «зайти на сервер» в меню игры: пишем адрес сервера и подкидываем мод.
    quickjoin::write_config(&paths, &mode)?;
    quickjoin::inject_mod(&app, &paths, &mode)?;

    progress.message("Запускаем игру");
    // Аккаунт G Land: игра должна ходить за авторизацией к нам, а не к Mojang.
    let mut extra_jvm: Vec<String> = Vec::new();
    if account.kind == AccountKind::GLand {
        let base = gland::base_from_manifest(&settings.manifest_url)?;
        let agent = gland::ensure_agent(&state.client, &paths.root).await?;
        extra_jvm.push(gland::agent_arg(&agent, &base));
    }

    let (java_path, args) =
        launch::build_command(&paths, &settings, &mode, &prepared, &account, &extra_jvm)?;

    launch::spawn(
        &app,
        state.child.clone(),
        mode_id.clone(),
        java_path,
        args,
        prepared.instance.clone(),
    )
    .await?;

    {
        let mut store = state.store.lock().await;
        store.settings.last_mode = Some(mode_id);
    }
    state.persist().await?;

    if settings.close_launcher_on_start {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
        }
    }
    Ok(())
}

/// Достаёт активный аккаунт, попутно обновляя токен Microsoft.
async fn active_account(state: &State<'_, AppState>) -> Result<Account> {
    let (account, client_id, manifest_url) = {
        let store = state.store.lock().await;
        let account = store
            .active()
            .cloned()
            .ok_or_else(|| Error::msg("сначала добавьте аккаунт"))?;
        (
            account,
            store.settings.effective_ms_client_id(),
            store.settings.manifest_url.clone(),
        )
    };

    // Токен игры живёт своей жизнью и берётся заново перед каждым запуском:
    // он короткий, а сессия лаунчера всё равно нужна на месте.
    if account.kind == AccountKind::GLand {
        let session = account
            .session
            .clone()
            .ok_or_else(|| Error::msg("войдите в аккаунт G Land заново"))?;
        let base = gland::base_from_manifest(&manifest_url)?;
        let fresh = gland::game_token(&state.client, &base, &session).await?;

        let updated = Account {
            id: account.id.clone(),
            // Токен игры аватарку не возвращает — оставляем прежнюю.
            avatar: account.avatar.clone(),
            ..fresh
        };
        {
            let mut store = state.store.lock().await;
            if let Some(slot) = store.accounts.iter_mut().find(|a| a.id == updated.id) {
                *slot = updated.clone();
            }
        }
        state.persist().await?;
        return Ok(updated);
    }

    if account.kind != AccountKind::Microsoft {
        return Ok(account);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if account.expires_at > now + 60 {
        return Ok(account);
    }

    let refreshed = auth::refresh(&state.client, &client_id, &account).await?;
    {
        let mut store = state.store.lock().await;
        if let Some(slot) = store.accounts.iter_mut().find(|a| a.id == refreshed.id) {
            *slot = refreshed.clone();
        }
    }
    state.persist().await?;
    Ok(refreshed)
}

#[tauri::command]
async fn stop_game(state: State<'_, AppState>) -> Result<()> {
    let mut slot = state.child.lock().await;
    if let Some(child) = slot.as_mut() {
        let _ = child.kill().await;
    }
    *slot = None;
    Ok(())
}

#[tauri::command]
async fn is_game_running(state: State<'_, AppState>) -> Result<bool> {
    let mut slot = state.child.lock().await;
    match slot.as_mut() {
        Some(child) => Ok(matches!(child.try_wait(), Ok(None))),
        None => Ok(false),
    }
}

#[tauri::command]
async fn add_offline_account(state: State<'_, AppState>, username: String) -> Result<Bootstrap> {
    let username = username.trim().to_string();
    if username.len() < 3 || username.len() > 16 {
        return Err(Error::msg("ник должен быть длиной от 3 до 16 символов"));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(Error::msg("в нике допустимы только латиница, цифры и _"));
    }

    {
        let mut store = state.store.lock().await;
        if store
            .accounts
            .iter()
            .any(|a| a.username.eq_ignore_ascii_case(&username) && a.kind == AccountKind::Offline)
        {
            return Err(Error::msg("такой аккаунт уже добавлен"));
        }
        let account = Account::offline(&username);
        store.active_account = Some(account.id.clone());
        store.accounts.push(account);
    }
    state.persist().await?;
    get_bootstrap(state).await
}

/// Вход через наш сервер: игрок подтверждает себя в Telegram.
#[tauri::command]
async fn gland_login_start(state: State<'_, AppState>) -> Result<gland::LoginStart> {
    let base = gland::base_from_manifest(&state.settings().await.manifest_url)?;
    gland::start_login(&state.client, &base).await
}

/// Возвращает `null`, пока игрок не нажал кнопку в боте.
#[tauri::command]
async fn gland_login_poll(state: State<'_, AppState>, token: String) -> Result<Option<Bootstrap>> {
    let base = gland::base_from_manifest(&state.settings().await.manifest_url)?;
    let Some((session, profile)) = gland::poll_login(&state.client, &base, &token).await? else {
        return Ok(None);
    };

    {
        let mut store = state.store.lock().await;
        // Тот же игрок мог входить раньше — обновляем запись, а не плодим копии.
        let existing = store
            .accounts
            .iter_mut()
            .find(|a| a.kind == AccountKind::GLand && a.uuid == profile.id);

        let id = match existing {
            Some(slot) => {
                slot.session = Some(session.clone());
                slot.username = profile.username.clone().unwrap_or_default();
                slot.avatar = profile.avatar.clone();
                slot.id.clone()
            }
            None => {
                let account = Account {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: AccountKind::GLand,
                    username: profile.username.clone().unwrap_or_default(),
                    uuid: profile.id.clone(),
                    access_token: String::new(),
                    refresh_token: None,
                    expires_at: 0,
                    xuid: None,
                    session: Some(session.clone()),
                    avatar: profile.avatar.clone(),
                };
                let id = account.id.clone();
                store.accounts.push(account);
                id
            }
        };
        store.active_account = Some(id);
    }

    state.persist().await?;
    get_bootstrap(state).await.map(Some)
}

/// Адрес сервера и сессия активного аккаунта G Land — их просят все команды ниже.
async fn gland_session(state: &State<'_, AppState>) -> Result<(String, String, String)> {
    let store = state.store.lock().await;
    let account = store
        .active()
        .filter(|a| a.kind == AccountKind::GLand)
        .ok_or_else(|| Error::msg("сначала войдите в аккаунт G Land"))?;
    let session = account
        .session
        .clone()
        .ok_or_else(|| Error::msg("войдите в аккаунт G Land заново"))?;

    Ok((
        gland::base_from_manifest(&store.settings.manifest_url)?,
        session,
        account.id.clone(),
    ))
}

/// Что игрок уже залил и что надето сейчас.
#[tauri::command]
async fn gland_textures(state: State<'_, AppState>) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::textures(&state.client, &base, &session).await
}

/// Заливка файла с диска: он попадает в библиотеку и сразу надевается.
#[tauri::command]
async fn gland_upload_texture(
    state: State<'_, AppState>,
    path: String,
    kind: String,
    model: String,
) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::upload_texture(
        &state.client,
        &base,
        &session,
        std::path::Path::new(&path),
        &kind,
        &model,
    )
    .await
}

#[tauri::command]
async fn gland_set_model(state: State<'_, AppState>, model: String) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::set_model(&state.client, &base, &session, &model).await
}

#[tauri::command]
async fn gland_select_texture(state: State<'_, AppState>, id: i64) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::select_texture(&state.client, &base, &session, id).await
}

#[tauri::command]
async fn gland_clear_texture(state: State<'_, AppState>, kind: String) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::clear_texture(&state.client, &base, &session, &kind).await
}

#[tauri::command]
async fn gland_delete_texture(state: State<'_, AppState>, id: i64) -> Result<gland::Library> {
    let (base, session, _) = gland_session(&state).await?;
    gland::delete_texture(&state.client, &base, &session, id).await
}

/// Ник меняется на сервере: UUID остаётся прежним, прогресс не теряется.
#[tauri::command]
async fn gland_set_nickname(state: State<'_, AppState>, username: String) -> Result<Bootstrap> {
    let (base, session, id) = gland_session(&state).await?;

    let profile = gland::set_nickname(&state.client, &base, &session, &username).await?;

    {
        let mut store = state.store.lock().await;
        if let Some(slot) = store.accounts.iter_mut().find(|a| a.id == id) {
            slot.username = profile.username.unwrap_or_default();
        }
    }
    state.persist().await?;
    get_bootstrap(state).await
}

#[tauri::command]
async fn ms_login_start(state: State<'_, AppState>) -> Result<auth::DeviceCode> {
    let client_id = state.settings().await.effective_ms_client_id();
    auth::start_device_code(&state.client, &client_id).await
}

/// Возвращает `null`, пока игрок не подтвердил вход в браузере.
#[tauri::command]
async fn ms_login_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<Option<Bootstrap>> {
    let client_id = state.settings().await.effective_ms_client_id();
    let Some(account) = auth::poll_device_code(&state.client, &client_id, &device_code).await?
    else {
        return Ok(None);
    };

    {
        let mut store = state.store.lock().await;
        store
            .accounts
            .retain(|existing| !existing.uuid.eq_ignore_ascii_case(&account.uuid));
        store.active_account = Some(account.id.clone());
        store.accounts.push(account);
    }
    state.persist().await?;
    Ok(Some(get_bootstrap(state).await?))
}

#[tauri::command]
async fn set_active_account(state: State<'_, AppState>, id: String) -> Result<Bootstrap> {
    {
        let mut store = state.store.lock().await;
        if !store.accounts.iter().any(|a| a.id == id) {
            return Err(Error::msg("аккаунт не найден"));
        }
        store.active_account = Some(id);
    }
    state.persist().await?;
    get_bootstrap(state).await
}

#[tauri::command]
async fn remove_account(state: State<'_, AppState>, id: String) -> Result<Bootstrap> {
    {
        let mut store = state.store.lock().await;
        store.accounts.retain(|a| a.id != id);
        if store.active_account.as_deref() == Some(id.as_str()) {
            store.active_account = store.accounts.first().map(|a| a.id.clone());
        }
    }
    state.persist().await?;
    get_bootstrap(state).await
}

#[tauri::command]
async fn open_mode_folder(state: State<'_, AppState>, mode_id: String) -> Result<()> {
    let paths = state.paths().await;
    let dir = paths.instance(&mode_id);
    std::fs::create_dir_all(&dir)?;
    open_in_file_manager(&dir)
}

#[tauri::command]
async fn open_game_root(state: State<'_, AppState>) -> Result<()> {
    let paths = state.paths().await;
    std::fs::create_dir_all(&paths.root)?;
    open_in_file_manager(&paths.root)
}

/// Полностью удаляет папку режима — например, чтобы переустановить сборку с нуля.
#[tauri::command]
async fn delete_mode(state: State<'_, AppState>, mode_id: String) -> Result<()> {
    if mode_id.contains(['/', '\\', ':']) {
        return Err(Error::msg("некорректный идентификатор режима"));
    }
    let paths = state.paths().await;
    let dir = paths.instance(&mode_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

fn open_in_file_manager(path: &std::path::Path) -> Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|err| Error::msg(format!("не удалось открыть папку: {err}")))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let config_file = config_dir.join("launcher.json");

            let default_root = app.path().app_data_dir()?.join("game");
            std::fs::create_dir_all(&default_root)?;

            let store = Store::load(&config_file);

            let client = Client::builder()
                .user_agent(concat!("gandoni-launcher/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(std::time::Duration::from_secs(15))
                .pool_max_idle_per_host(16)
                .build()
                .expect("не удалось создать http-клиент");

            app.manage(AppState {
                client,
                store: Mutex::new(store),
                manifest: Mutex::new(None),
                child: Arc::new(Mutex::new(None)),
                default_root,
                config_file,
                busy: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            save_settings,
            fetch_manifest,
            check_updates,
            install_mode,
            play,
            stop_game,
            is_game_running,
            add_offline_account,
            gland_login_start,
            gland_login_poll,
            gland_set_nickname,
            gland_textures,
            gland_upload_texture,
            gland_set_model,
            gland_select_texture,
            gland_clear_texture,
            gland_delete_texture,
            ms_login_start,
            ms_login_poll,
            set_active_account,
            remove_account,
            open_mode_folder,
            open_game_root,
            delete_mode
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить лаунчер");
}
