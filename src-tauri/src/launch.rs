use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::config::{Account, AccountKind, Paths, Settings};
use crate::error::{Error, Result};
use crate::installer::Prepared;
use crate::manifest::Mode;
use crate::mojang::{self, VersionJson};
use crate::progress::{EVENT_GAME_STATE, EVENT_LOG};
use crate::util::classpath_separator;

pub type SharedChild = Arc<Mutex<Option<tokio::process::Child>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPayload {
    line: String,
    error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameStatePayload {
    mode: String,
    running: bool,
    exit_code: Option<i32>,
    message: String,
}

/// Раскрывает `${переменные}` в аргументах запуска.
fn substitute(text: &str, vars: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (key, value) in vars {
        let needle = format!("${{{key}}}");
        if out.contains(&needle) {
            out = out.replace(&needle, value);
        }
    }
    out
}

/// Разворачивает массив аргументов из version.json с учётом правил ОС.
fn collect_args(items: &[Value], vars: &HashMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        match item {
            Value::String(text) => out.push(substitute(text, vars)),
            Value::Object(object) => {
                let rules: Vec<mojang::Rule> = object
                    .get("rules")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default();
                if !mojang::rules_allow(&rules) {
                    continue;
                }
                match object.get("value") {
                    Some(Value::String(text)) => out.push(substitute(text, vars)),
                    Some(Value::Array(values)) => {
                        for value in values {
                            if let Value::String(text) = value {
                                out.push(substitute(text, vars));
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

fn build_classpath(version: &VersionJson, paths: &Paths, client_jar: &PathBuf) -> Result<String> {
    let libraries = mojang::resolve_libraries(version, paths)?;
    let mut entries: Vec<String> = Vec::new();
    for path in libraries.classpath {
        let text = path.to_string_lossy().to_string();
        if !entries.contains(&text) {
            entries.push(text);
        }
    }
    entries.push(client_jar.to_string_lossy().to_string());
    Ok(entries.join(classpath_separator()))
}

/// Собирает полную командную строку java для запуска игры.
pub fn build_command(
    paths: &Paths,
    settings: &Settings,
    mode: &Mode,
    prepared: &Prepared,
    account: &Account,
    // Аргументы JVM от самого лаунчера — идут перед пользовательскими.
    extra_jvm: &[String],
) -> Result<(PathBuf, Vec<String>)> {
    let version = &prepared.version;
    let natives = paths.natives(&version.id);
    let classpath = build_classpath(version, paths, &prepared.client_jar)?;

    let assets_index = version
        .asset_index
        .as_ref()
        .map(|index| index.id.clone())
        .or_else(|| version.assets.clone())
        .unwrap_or_else(|| "legacy".to_string());

    let game_assets = prepared
        .asset_index
        .as_ref()
        .filter(|(index, _)| index.is_virtual || index.map_to_resources)
        .map(|(index, id)| {
            if index.map_to_resources {
                prepared.instance.join("resources")
            } else {
                paths.assets().join("virtual").join(id)
            }
        })
        .unwrap_or_else(|| paths.assets());

    let user_type = match account.kind {
        AccountKind::Microsoft => "msa",
        // Своя авторизация выглядит для игры как старая мояновская: именно
        // такой тип ждёт authlib-injector.
        AccountKind::GLand => "mojang",
        AccountKind::Offline => "legacy",
    };

    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("auth_player_name".into(), account.username.clone());
    vars.insert("version_name".into(), version.id.clone());
    vars.insert(
        "game_directory".into(),
        prepared.instance.to_string_lossy().to_string(),
    );
    vars.insert(
        "assets_root".into(),
        paths.assets().to_string_lossy().to_string(),
    );
    vars.insert(
        "game_assets".into(),
        game_assets.to_string_lossy().to_string(),
    );
    vars.insert("assets_index_name".into(), assets_index);
    vars.insert("auth_uuid".into(), account.uuid.replace('-', ""));
    vars.insert("auth_access_token".into(), account.access_token.clone());
    vars.insert("auth_session".into(), format!("token:{}", account.access_token));
    vars.insert("user_type".into(), user_type.to_string());
    vars.insert("user_properties".into(), "{}".into());
    vars.insert(
        "version_type".into(),
        version.kind.clone().unwrap_or_else(|| "release".into()),
    );
    vars.insert(
        "natives_directory".into(),
        natives.to_string_lossy().to_string(),
    );
    vars.insert("launcher_name".into(), "gandoni-launcher".into());
    vars.insert("launcher_version".into(), env!("CARGO_PKG_VERSION").into());
    vars.insert("classpath".into(), classpath);
    vars.insert("classpath_separator".into(), classpath_separator().into());
    vars.insert(
        "library_directory".into(),
        paths.libraries().to_string_lossy().to_string(),
    );
    vars.insert("clientid".into(), String::new());
    vars.insert(
        "auth_xuid".into(),
        account.xuid.clone().unwrap_or_default(),
    );
    vars.insert("resolution_width".into(), "1280".into());
    vars.insert("resolution_height".into(), "720".into());

    let max_memory = mode.memory.max.unwrap_or(settings.memory_mb).max(512);
    let min_memory = mode.memory.min.unwrap_or(512).min(max_memory);

    let mut args: Vec<String> = Vec::new();
    args.push(format!("-Xms{min_memory}M"));
    args.push(format!("-Xmx{max_memory}M"));
    if cfg!(target_os = "macos") {
        args.push("-Xdock:name=Minecraft".into());
    }

    // Сначала то, что просит сам лаунчер (например, агент своей авторизации),
    // потом настройки игрока и режима — так их проще перебить вручную.
    for extra in extra_jvm {
        args.push(extra.clone());
    }
    for extra in settings.jvm_args.split_whitespace() {
        args.push(extra.to_string());
    }
    if let Some(extra) = &mode.jvm_args {
        for arg in extra.split_whitespace() {
            args.push(arg.to_string());
        }
    }

    // Forge и NeoForge перечисляют в ignoreList то, что не должно попасть на
    // module path, и среди прочего там стоит `${version_name}.jar`. Ждут они
    // имя ванильного jar — именно он лежит на classpath. Подставишь составной
    // id (neoforge-20.2.93) — ванильный jar не попадёт в исключения, окажется
    // на module path отдельным модулем и столкнётся с пропатченным minecraft:
    // «Module minecraft contains package net.minecraft.client.main, module
    // _1._20._2 exports package net.minecraft.client.main to minecraft».
    // В игровых аргументах `--version` при этом должен остаться прежним.
    let mut jvm_vars = vars.clone();
    if let Some(stem) = prepared.client_jar.file_stem() {
        jvm_vars.insert("version_name".into(), stem.to_string_lossy().to_string());
    }

    match version.arguments.as_ref() {
        Some(arguments) if !arguments.jvm.is_empty() => {
            args.extend(collect_args(&arguments.jvm, &jvm_vars));
        }
        _ => {
            args.push(format!("-Djava.library.path={}", vars["natives_directory"]));
            args.push("-cp".into());
            args.push(vars["classpath"].clone());
        }
    }

    let main_class = version
        .main_class
        .clone()
        .ok_or_else(|| Error::msg("в version.json нет mainClass"))?;
    args.push(main_class);

    let mut game_args: Vec<String> = match version.arguments.as_ref() {
        Some(arguments) if !arguments.game.is_empty() => collect_args(&arguments.game, &vars),
        _ => version
            .minecraft_arguments
            .clone()
            .unwrap_or_default()
            .split_whitespace()
            .map(|arg| substitute(arg, &vars))
            .collect(),
    };

    // Нерасхлопнутые плейсхолдеры ломают запуск — выкидываем их вместе с ключом.
    let mut cleaned: Vec<String> = Vec::with_capacity(game_args.len());
    let mut index = 0;
    while index < game_args.len() {
        let current = &game_args[index];
        let next_is_placeholder = game_args
            .get(index + 1)
            .map(|next| next.contains("${"))
            .unwrap_or(false);
        if current.contains("${") {
            index += 1;
            continue;
        }
        if current.starts_with("--") && next_is_placeholder {
            index += 2;
            continue;
        }
        cleaned.push(current.clone());
        index += 1;
    }
    game_args = cleaned;

    if settings.fullscreen {
        game_args.push("--fullscreen".into());
    }

    if settings.auto_connect {
        if let Some(server) = &mode.server {
            let supports_quick_play = version
                .arguments
                .as_ref()
                .map(|arguments| {
                    serde_json::to_string(&arguments.game)
                        .unwrap_or_default()
                        .contains("quickPlayMultiplayer")
                })
                .unwrap_or(false);
            if supports_quick_play {
                game_args.push("--quickPlayMultiplayer".into());
                game_args.push(format!("{}:{}", server.host, server.port));
            } else {
                game_args.push("--server".into());
                game_args.push(server.host.clone());
                game_args.push("--port".into());
                game_args.push(server.port.to_string());
            }
        }
    }

    args.extend(game_args);
    Ok((prepared.java.clone(), args))
}

/// Запускает игру и стримит её вывод во фронтенд.
pub async fn spawn(
    app: &AppHandle,
    child_slot: SharedChild,
    mode_id: String,
    java: PathBuf,
    args: Vec<String>,
    working_dir: PathBuf,
) -> Result<()> {
    {
        let mut slot = child_slot.lock().await;
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Err(Error::msg("игра уже запущена"));
            }
        }
    }

    let mut command = tokio::process::Command::new(&java);
    command
        .args(&args)
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = command.spawn().map_err(|err| {
        Error::msg(format!(
            "не удалось запустить {}: {err}",
            java.display()
        ))
    })?;

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(EVENT_LOG, LogPayload { line, error: false });
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(EVENT_LOG, LogPayload { line, error: true });
            }
        });
    }

    *child_slot.lock().await = Some(child);

    let _ = app.emit(
        EVENT_GAME_STATE,
        GameStatePayload {
            mode: mode_id.clone(),
            running: true,
            exit_code: None,
            message: "Игра запускается".into(),
        },
    );

    // Ждём завершения, не удерживая мьютекс: иначе кнопка «Остановить» встанет колом.
    let app_handle = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let mut slot = child_slot.lock().await;
            let Some(child) = slot.as_mut() else {
                break;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    *slot = None;
                    drop(slot);
                    let message = match code {
                        Some(0) | None => "Игра закрыта".to_string(),
                        Some(code) => format!("Игра завершилась с кодом {code}"),
                    };
                    let _ = app_handle.emit(
                        EVENT_GAME_STATE,
                        GameStatePayload {
                            mode: mode_id.clone(),
                            running: false,
                            exit_code: code,
                            message,
                        },
                    );
                    break;
                }
                Ok(None) => continue,
                Err(_) => {
                    *slot = None;
                    break;
                }
            }
        }
    });

    Ok(())
}
