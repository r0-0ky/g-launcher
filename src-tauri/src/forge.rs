use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::config::Paths;
use crate::download::{download_all, get_bytes, Task};
use crate::error::{Error, Result};
use crate::progress::Progress;
use crate::util::{ensure_parent, maven_to_path, sha1_file, write_json};

const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";
const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Forge,
    NeoForge,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallProfile {
    #[serde(default)]
    version: Option<String>,
    /// Старый формат (<= 1.12): вся информация о версии лежит здесь.
    #[serde(default)]
    version_info: Option<Value>,
    #[serde(default)]
    install: Option<LegacyInstall>,
    #[serde(default)]
    data: HashMap<String, SideValue>,
    #[serde(default)]
    processors: Vec<Processor>,
    #[serde(default)]
    libraries: Vec<crate::mojang::Library>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyInstall {
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SideValue {
    #[serde(default)]
    client: String,
}

#[derive(Debug, Deserialize)]
struct Processor {
    jar: String,
    #[serde(default)]
    classpath: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    outputs: HashMap<String, String>,
    #[serde(default)]
    sides: Vec<String>,
}

fn installer_url(flavor: Flavor, mc_version: &str, loader_version: &str) -> String {
    match flavor {
        Flavor::Forge => format!(
            "{FORGE_MAVEN}/net/minecraftforge/forge/{mc_version}-{loader_version}/forge-{mc_version}-{loader_version}-installer.jar"
        ),
        Flavor::NeoForge => format!(
            "{NEOFORGE_MAVEN}/net/neoforged/neoforge/{loader_version}/neoforge-{loader_version}-installer.jar"
        ),
    }
}

/// Тянет maven-metadata.xml и выбирает самую свежую версию под нужный Minecraft.
pub async fn latest_loader(client: &Client, flavor: Flavor, mc_version: &str) -> Result<String> {
    let (url, prefix) = match flavor {
        Flavor::Forge => (
            format!("{FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml"),
            format!("{mc_version}-"),
        ),
        Flavor::NeoForge => {
            // 1.21.1 -> 21.1., 1.20.4 -> 20.4.
            let parts: Vec<&str> = mc_version.split('.').collect();
            if parts.len() < 2 {
                return Err(Error::msg(format!("непонятная версия Minecraft: {mc_version}")));
            }
            let minor = parts[1];
            let patch = parts.get(2).copied().unwrap_or("0");
            (
                format!("{NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml"),
                format!("{minor}.{patch}."),
            )
        }
    };

    let xml = String::from_utf8_lossy(&get_bytes(client, &url).await?).to_string();
    let mut candidates: Vec<String> = Vec::new();
    for chunk in xml.split("<version>").skip(1) {
        if let Some(end) = chunk.find("</version>") {
            let version = chunk[..end].trim().to_string();
            if version.starts_with(&prefix) && !version.contains("beta") {
                candidates.push(version);
            }
        }
    }
    let latest = candidates
        .pop()
        .ok_or_else(|| Error::msg(format!("нет сборок лоадера под Minecraft {mc_version}")))?;

    Ok(match flavor {
        Flavor::Forge => latest
            .strip_prefix(&prefix)
            .unwrap_or(&latest)
            .to_string(),
        Flavor::NeoForge => latest,
    })
}

/// Ставит Forge/NeoForge и возвращает id версии для запуска.
///
/// Современные установщики не просто распаковывают файлы: они прогоняют
/// цепочку processors (деобфускация, бинарные патчи), поэтому нужен java.
pub async fn install(
    client: &Client,
    paths: &Paths,
    java: &Path,
    flavor: Flavor,
    mc_version: &str,
    loader_version: &str,
    vanilla_jar: &Path,
    progress: &Progress,
) -> Result<String> {
    progress.stage("Загрузка лоадера", "Скачиваем установщик");

    let url = installer_url(flavor, mc_version, loader_version);
    let installer_path = paths
        .cache()
        .join("installers")
        .join(url.rsplit('/').next().unwrap_or("installer.jar"));

    if !installer_path.exists() {
        download_all(
            client,
            vec![Task::new(url.clone(), installer_path.clone())],
            1,
            false,
            progress,
        )
        .await?;
    }

    let profile_bytes = read_zip_entry(&installer_path, "install_profile.json")?
        .ok_or_else(|| Error::msg("в установщике нет install_profile.json"))?;
    let profile: InstallProfile = serde_json::from_slice(&profile_bytes)?;

    // Старый формат (Minecraft <= 1.12): универсальный jar просто копируется.
    if let Some(version_info) = &profile.version_info {
        let id = version_info
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::msg("versionInfo без id"))?
            .to_string();
        write_json(&paths.version_json(&id), version_info)?;

        if let Some(install) = &profile.install {
            if let (Some(file_path), Some(maven)) = (&install.file_path, &install.path) {
                let dest = paths.libraries().join(maven_to_path(maven)?);
                if !dest.exists() {
                    if let Some(bytes) = read_zip_entry(&installer_path, file_path)? {
                        ensure_parent(&dest)?;
                        std::fs::write(&dest, bytes)?;
                    }
                }
            }
        }
        return Ok(id);
    }

    // Современный формат.
    let version_bytes = read_zip_entry(&installer_path, "version.json")?
        .ok_or_else(|| Error::msg("в установщике нет version.json"))?;
    let version_json: Value = serde_json::from_slice(&version_bytes)?;
    let id = version_json
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("version.json установщика без id"))?
        .to_string();
    write_json(&paths.version_json(&id), &version_json)?;

    // Часть библиотек лежит прямо внутри установщика.
    let data_dir = paths.cache().join(format!("forge-data-{id}"));
    extract_installer_payload(&installer_path, &paths.libraries(), &data_dir)?;

    // Библиотеки, нужные самим процессорам.
    progress.stage("Загрузка лоадера", "Библиотеки установщика");
    let mut tasks = Vec::new();
    for lib in &profile.libraries {
        let Some(downloads) = &lib.downloads else {
            continue;
        };
        let Some(artifact) = &downloads.artifact else {
            continue;
        };
        if artifact.url.is_empty() {
            continue;
        }
        let rel = match &artifact.path {
            Some(path) => PathBuf::from(path),
            None => maven_to_path(&lib.name)?,
        };
        tasks.push(
            Task::new(artifact.url.clone(), paths.libraries().join(rel))
                .with_hash(artifact.sha1.clone(), artifact.size),
        );
    }
    download_all(client, tasks, 8, false, progress).await?;

    if profile.processors.is_empty() {
        return Ok(id);
    }

    // Значения-подстановки для процессоров.
    let mut data: HashMap<String, String> = HashMap::new();
    for (key, value) in &profile.data {
        let resolved = resolve_data_value(&value.client, paths, &data_dir)?;
        data.insert(key.clone(), resolved);
    }
    data.insert(
        "MINECRAFT_JAR".into(),
        vanilla_jar.to_string_lossy().to_string(),
    );
    data.insert("MINECRAFT_VERSION".into(), mc_version.to_string());
    data.insert("ROOT".into(), paths.root.to_string_lossy().to_string());
    data.insert(
        "INSTALLER".into(),
        installer_path.to_string_lossy().to_string(),
    );
    data.insert(
        "LIBRARY_DIR".into(),
        paths.libraries().to_string_lossy().to_string(),
    );
    data.insert("SIDE".into(), "client".into());
    if let Some(version) = &profile.version {
        data.insert("VERSION".into(), version.clone());
    }
    if let Some(path) = &profile.path {
        data.insert("PATH".into(), path.clone());
    }

    let total = profile.processors.len();
    for (index, processor) in profile.processors.iter().enumerate() {
        if !processor.sides.is_empty() && !processor.sides.iter().any(|s| s == "client") {
            continue;
        }
        if processor_outputs_ready(processor, &data, paths)? {
            continue;
        }
        progress.stage(
            "Установка лоадера",
            &format!("Обработка файлов {}/{total}", index + 1),
        );
        run_processor(java, processor, &data, paths)?;
    }

    Ok(id)
}

/// Достаёт из установщика встроенные maven-артефакты и data-файлы.
fn extract_installer_payload(installer: &Path, libraries: &Path, data_dir: &Path) -> Result<()> {
    let file = std::fs::File::open(installer)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let name_str = name.to_string_lossy().replace('\\', "/");

        let dest = if let Some(rest) = name_str.strip_prefix("maven/") {
            libraries.join(rest)
        } else if let Some(rest) = name_str.strip_prefix("data/") {
            data_dir.join(rest)
        } else {
            continue;
        };

        if dest.exists() {
            continue;
        }
        ensure_parent(&dest)?;
        let mut out = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// `[maven:coords]` -> путь в libraries, `/data/x.lzma` -> распакованный файл, иначе литерал.
fn resolve_data_value(value: &str, paths: &Paths, data_dir: &Path) -> Result<String> {
    if value.starts_with('[') && value.ends_with(']') {
        let coords = &value[1..value.len() - 1];
        let path = paths.libraries().join(maven_to_path(coords)?);
        return Ok(path.to_string_lossy().to_string());
    }
    if let Some(rest) = value.strip_prefix('/') {
        let rest = rest.strip_prefix("data/").unwrap_or(rest);
        let path = data_dir.join(rest);
        return Ok(path.to_string_lossy().to_string());
    }
    Ok(value.trim_matches('\'').to_string())
}

fn substitute(arg: &str, data: &HashMap<String, String>, paths: &Paths) -> Result<String> {
    if arg.starts_with('{') && arg.ends_with('}') {
        let key = &arg[1..arg.len() - 1];
        return Ok(data.get(key).cloned().unwrap_or_else(|| arg.to_string()));
    }
    if arg.starts_with('[') && arg.ends_with(']') {
        let coords = &arg[1..arg.len() - 1];
        let path = paths.libraries().join(maven_to_path(coords)?);
        return Ok(path.to_string_lossy().to_string());
    }
    Ok(arg.to_string())
}

fn processor_outputs_ready(
    processor: &Processor,
    data: &HashMap<String, String>,
    paths: &Paths,
) -> Result<bool> {
    if processor.outputs.is_empty() {
        return Ok(false);
    }
    for (key, expected) in &processor.outputs {
        let path = PathBuf::from(substitute(key, data, paths)?);
        if !path.exists() {
            return Ok(false);
        }
        let expected = substitute(expected, data, paths)?;
        if expected.is_empty() {
            continue;
        }
        let expected = expected.trim_matches('\'');
        if !sha1_file(&path)?.eq_ignore_ascii_case(expected) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn run_processor(
    java: &Path,
    processor: &Processor,
    data: &HashMap<String, String>,
    paths: &Paths,
) -> Result<()> {
    let jar_path = paths.libraries().join(maven_to_path(&processor.jar)?);
    if !jar_path.exists() {
        return Err(Error::msg(format!(
            "не хватает файла процессора: {}",
            jar_path.display()
        )));
    }

    let main_class = main_class_of(&jar_path)?;

    let mut classpath: Vec<String> = vec![jar_path.to_string_lossy().to_string()];
    for entry in &processor.classpath {
        let path = paths.libraries().join(maven_to_path(entry)?);
        classpath.push(path.to_string_lossy().to_string());
    }

    let mut args = Vec::new();
    for arg in &processor.args {
        args.push(substitute(arg, data, paths)?);
    }

    let mut command = Command::new(java);
    command
        .arg("-cp")
        .arg(classpath.join(crate::util::classpath_separator()))
        .arg(&main_class)
        .args(&args)
        .current_dir(&paths.root);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let tail: String = stdout
            .lines()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(Error::msg(format!(
            "процессор {main_class} завершился с ошибкой:\n{tail}\n{stderr}"
        )));
    }
    Ok(())
}

fn main_class_of(jar: &Path) -> Result<String> {
    let bytes = read_zip_entry(jar, "META-INF/MANIFEST.MF")?
        .ok_or_else(|| Error::msg(format!("нет MANIFEST.MF в {}", jar.display())))?;
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("Main-Class:") {
            return Ok(value.trim().to_string());
        }
    }
    Err(Error::msg(format!(
        "в {} не указан Main-Class",
        jar.display()
    )))
}

fn read_zip_entry(archive_path: &Path, entry_name: &str) -> Result<Option<Vec<u8>>> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let Some(index) = archive.index_for_name(entry_name) else {
        return Ok(None);
    };
    let mut entry = archive.by_index(index)?;
    let mut buffer = Vec::new();
    entry.read_to_end(&mut buffer)?;
    Ok(Some(buffer))
}
