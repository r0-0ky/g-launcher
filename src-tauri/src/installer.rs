use std::path::PathBuf;

use reqwest::Client;

use crate::config::{Paths, Settings};
use crate::download::{download_all, Task};
use crate::error::{Error, Result};
use crate::manifest::{LoaderKind, Mode};
use crate::mojang::{self, AssetIndex, VersionJson};
use crate::progress::Progress;
use crate::sync::{self, InstanceState};
use crate::{fabric, forge, java};

pub struct Prepared {
    pub version: VersionJson,
    pub java: PathBuf,
    pub instance: PathBuf,
    pub client_jar: PathBuf,
    pub asset_index: Option<(AssetIndex, String)>,
}

/// Сводка по обновлению — показывается до того, как что-то качать.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub mode_id: String,
    pub installed: bool,
    pub needs_update: bool,
    pub files_to_download: usize,
    pub files_to_delete: usize,
    pub download_bytes: u64,
    pub delete_names: Vec<String>,
}

/// Что изменится в папке режима, без единого сетевого запроса за файлами.
pub fn check_updates(mode: &Mode, paths: &Paths, verify: bool) -> Result<UpdateReport> {
    let state = InstanceState::load(paths, &mode.id);
    let plan = sync::plan(mode, paths, &state, verify)?;
    let installed = !state.version_id.is_empty();

    let delete_names = plan
        .delete
        .iter()
        .filter_map(|path| path.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    Ok(UpdateReport {
        mode_id: mode.id.clone(),
        installed,
        needs_update: !installed || !plan.is_empty(),
        files_to_download: plan.download.len(),
        files_to_delete: plan.delete.len(),
        download_bytes: plan.download_bytes,
        delete_names,
    })
}

/// Полная подготовка режима: версия, лоадер, библиотеки, ассеты, Java и моды.
pub async fn prepare(
    client: &Client,
    paths: &Paths,
    settings: &Settings,
    mode: &Mode,
    verify: bool,
    progress: &Progress,
) -> Result<Prepared> {
    let instance = paths.instance(&mode.id);
    std::fs::create_dir_all(&instance)?;

    // 1. Ванильная версия — фундамент для всего остального.
    progress.stage("Версия", &format!("Minecraft {}", mode.minecraft));
    let vanilla = mojang::resolve_version(client, paths, &mode.minecraft).await?;

    let client_jar = paths.version_jar(&vanilla.id);
    if let Some(downloads) = &vanilla.downloads {
        if let Some(artifact) = &downloads.client {
            progress.stage("Версия", "Клиент Minecraft");
            download_all(
                client,
                vec![Task::new(artifact.url.clone(), client_jar.clone())
                    .with_hash(artifact.sha1.clone(), artifact.size)],
                1,
                verify,
                progress,
            )
            .await?;
        }
    }

    // 2. Java нужна раньше лоадера: установщик Forge гоняет свои процессоры на ней.
    let required_major = mode
        .java
        .as_ref()
        .map(|java| java.major)
        .filter(|major| *major > 0)
        .or_else(|| vanilla.java_version.as_ref().map(|java| java.major_version))
        .unwrap_or(8);
    let component = mode
        .java
        .as_ref()
        .and_then(|java| java.component.clone())
        .or_else(|| vanilla.java_version.as_ref().map(|java| java.component.clone()));

    let java_path = java::resolve(
        client,
        paths,
        settings.java_path.as_deref(),
        component.as_deref(),
        required_major,
        progress,
    )
    .await?;

    // 3. Лоадер.
    let version_id = match mode.loader.kind {
        LoaderKind::Vanilla => vanilla.id.clone(),
        LoaderKind::Fabric | LoaderKind::Quilt => {
            progress.stage("Лоадер", "Устанавливаем Fabric");
            fabric::install(
                client,
                paths,
                &mode.minecraft,
                mode.loader.version.as_deref(),
                mode.loader.kind == LoaderKind::Quilt,
            )
            .await?
        }
        LoaderKind::Forge | LoaderKind::Neoforge => {
            let flavor = if mode.loader.kind == LoaderKind::Forge {
                forge::Flavor::Forge
            } else {
                forge::Flavor::NeoForge
            };
            let loader_version = match mode.loader.version.as_deref() {
                Some(version) if !version.is_empty() && version != "latest" => version.to_string(),
                _ => forge::latest_loader(client, flavor, &mode.minecraft).await?,
            };
            forge::install(
                client,
                paths,
                &java_path,
                flavor,
                &mode.minecraft,
                &loader_version,
                &client_jar,
                progress,
            )
            .await?
        }
    };

    // 4. Собираем итоговый version.json со всеми наследованиями.
    let version = mojang::resolve_version(client, paths, &version_id).await?;

    // 5. Библиотеки.
    progress.stage("Библиотеки", "Загружаем зависимости");
    let libraries = mojang::resolve_libraries(&version, paths)?;
    let optional: std::collections::HashSet<PathBuf> =
        libraries.local_only.iter().cloned().collect();
    let (strict, lenient): (Vec<Task>, Vec<Task>) = libraries
        .tasks
        .iter()
        .cloned()
        .partition(|task| !optional.contains(&task.dest));

    download_all(client, strict, 12, verify, progress).await?;
    // Часть библиотек лоадера не раздаётся по HTTP — их приносит установщик.
    for task in lenient {
        if task.dest.exists() {
            continue;
        }
        let single = vec![task.clone()];
        if download_all(client, single, 1, false, progress).await.is_err() && !task.dest.exists() {
            return Err(Error::msg(format!(
                "не хватает библиотеки {}",
                task.dest.display()
            )));
        }
    }

    // 6. Ассеты.
    progress.stage("Ресурсы", "Звуки и текстуры");
    let (asset_tasks, asset_index) = mojang::resolve_assets(client, paths, &version).await?;
    download_all(client, asset_tasks, 16, verify, progress).await?;
    if let Some((index, index_id)) = &asset_index {
        mojang::materialize_virtual_assets(paths, index, index_id, &instance)?;
    }

    // 7. Нативные библиотеки.
    progress.stage("Ресурсы", "Распаковываем нативные библиотеки");
    mojang::extract_natives(&libraries.natives, &paths.natives(&version.id))?;

    // 8. Моды и конфиги режима.
    let mut state = InstanceState::load(paths, &mode.id);
    let plan = sync::plan(mode, paths, &state, verify)?;

    if !plan.delete.is_empty() {
        progress.stage(
            "Обновление",
            &format!("Удаляем {} лишних файлов", plan.delete.len()),
        );
        sync::apply_deletions(&plan)?;
    }
    if !plan.download.is_empty() {
        progress.stage("Моды", &format!("Файлов к загрузке: {}", plan.download.len()));
        download_all(client, plan.download, 8, verify, progress).await?;
    }

    state.version_id = version.id.clone();
    state.mode_version = mode.version.clone();
    state.installed = sync::installed_paths(mode);
    state.installed_at = Some(now_iso());
    state.save(paths, &mode.id)?;

    progress.finish("Готово к запуску");

    Ok(Prepared {
        version,
        java: java_path,
        instance,
        client_jar,
        asset_index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Account;
    use crate::util::classpath_separator;

    /// Полный прогон установки ванильной версии и сборки команды запуска.
    /// Качает несколько сотен мегабайт: `cargo test -- --ignored installs_vanilla`.
    #[tokio::test]
    #[ignore = "требует сети и качает ~500 МБ"]
    async fn installs_vanilla_and_builds_command() {
        let root = std::env::var("GANDONI_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("gandoni-e2e"));
        let paths = Paths::new(root);
        let settings = Settings::default();
        let progress = Progress::silent("test-vanilla");
        let client = reqwest::Client::new();

        let mode = Mode {
            id: "test-vanilla".into(),
            name: "Тест".into(),
            minecraft: "1.20.1".into(),
            ..Default::default()
        };

        let prepared = prepare(&client, &paths, &settings, &mode, false, &progress)
            .await
            .expect("установка не прошла");

        assert!(prepared.client_jar.exists(), "нет client.jar");
        assert!(prepared.java.exists(), "нет java");
        let natives = paths.natives(&prepared.version.id);
        assert!(
            natives.read_dir().map(|dir| dir.count()).unwrap_or(0) > 0,
            "нативные библиотеки не распакованы"
        );

        let account = Account::offline("TestPlayer");
        let (java, args) =
            crate::launch::build_command(&paths, &settings, &mode, &prepared, &account, &[]).unwrap();

        assert_eq!(java, prepared.java);
        let joined = args.join(" ");
        assert!(joined.contains("net.minecraft.client.main.Main"), "нет mainClass");
        assert!(joined.contains("TestPlayer"), "нет ника игрока");
        assert!(!joined.contains("${"), "остались нераскрытые переменные: {joined}");

        // Каждый элемент classpath должен реально лежать на диске.
        let cp_index = args.iter().position(|arg| arg == "-cp").expect("нет -cp");
        for entry in args[cp_index + 1].split(classpath_separator()) {
            assert!(
                std::path::Path::new(entry).exists(),
                "в classpath отсутствует файл: {entry}"
            );
        }
    }

    /// Реально запускает игру на полминуты и убеждается, что клиент дошёл до инициализации.
    /// Открывает окно Minecraft: `cargo test -- --ignored actually_launches`.
    #[tokio::test]
    #[ignore = "запускает настоящую игру"]
    async fn actually_launches_the_game() {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let root = std::env::var("GANDONI_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("gandoni-e2e"));
        let paths = Paths::new(root);
        let settings = Settings::default();
        let progress = Progress::silent("test-vanilla");
        let client = reqwest::Client::new();

        let mode = Mode {
            id: "test-vanilla".into(),
            name: "Тест".into(),
            minecraft: "1.20.1".into(),
            ..Default::default()
        };

        let prepared = prepare(&client, &paths, &settings, &mode, false, &progress)
            .await
            .unwrap();
        let account = Account::offline("TestPlayer");
        let (java, args) =
            crate::launch::build_command(&paths, &settings, &mode, &prepared, &account, &[]).unwrap();

        println!("$ {} {}", java.display(), args.join(" "));

        let mut child = tokio::process::Command::new(&java)
            .args(&args)
            // cargo test подсовывает свой DYLD_*; в игре он ломает загрузку нативных библиотек.
            .env_remove("DYLD_FALLBACK_LIBRARY_PATH")
            .env_remove("DYLD_LIBRARY_PATH")
            .current_dir(&prepared.instance)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    println!("[game:err] {line}");
                }
            });
        }

        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let mut started = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);

        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line()).await {
                Ok(Ok(Some(line))) => {
                    println!("[game] {line}");
                    // Эти строки печатает только успешно стартовавший клиент.
                    if line.contains("Setting user:") || line.contains("LWJGL") {
                        started = true;
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                _ => break,
            }
        }

        let _ = child.kill().await;
        assert!(started, "игра не дошла до инициализации клиента");
    }
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
