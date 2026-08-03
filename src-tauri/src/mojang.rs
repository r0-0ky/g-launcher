use std::collections::HashMap;
use std::path::PathBuf;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::Paths;
use crate::download::{get_json, Task};
use crate::error::{Error, Result};
use crate::util::{maven_to_path, os_arch, os_name, read_json, write_json};

pub const VERSION_MANIFEST: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const RESOURCES: &str = "https://resources.download.minecraft.net";
pub const DEFAULT_LIB_REPO: &str = "https://libraries.minecraft.net/";

#[derive(Debug, Clone, Deserialize)]
pub struct VersionManifest {
    pub versions: Vec<ManifestVersion>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestVersion {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VersionJson {
    pub id: String,
    pub inherits_from: Option<String>,
    pub main_class: Option<String>,
    pub minecraft_arguments: Option<String>,
    pub arguments: Option<Arguments>,
    pub libraries: Vec<Library>,
    pub asset_index: Option<AssetIndexRef>,
    pub assets: Option<String>,
    pub downloads: Option<ClientDownloads>,
    pub java_version: Option<JavaVersion>,
    pub logging: Option<Value>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Для forge-профилей: из какой версии брать client.jar.
    pub jar: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Arguments {
    pub game: Vec<Value>,
    pub jvm: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetIndexRef {
    pub id: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub total_size: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ClientDownloads {
    pub client: Option<Artifact>,
    pub server: Option<Artifact>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaVersion {
    pub component: String,
    pub major_version: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Artifact {
    pub path: Option<String>,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LibDownloads {
    pub artifact: Option<Artifact>,
    pub classifiers: HashMap<String, Artifact>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Library {
    pub name: String,
    pub downloads: Option<LibDownloads>,
    /// Базовый maven-репозиторий (так делают fabric и forge).
    pub url: Option<String>,
    pub rules: Vec<Rule>,
    pub natives: HashMap<String, String>,
    pub extract: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
    pub features: HashMap<String, bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OsRule {
    pub name: Option<String>,
    pub arch: Option<String>,
    pub version: Option<String>,
}

/// Проходят ли правила для текущей ОС. Фичи (demo, custom resolution) выключены.
pub fn rules_allow(rules: &[Rule]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        let mut matches = true;
        if let Some(os) = &rule.os {
            if let Some(name) = &os.name {
                if name != os_name() {
                    matches = false;
                }
            }
            if let Some(arch) = &os.arch {
                let current = if cfg!(target_arch = "x86") { "x86" } else { os_arch() };
                if arch != current && !(arch == "x86_64" && current == "x64") {
                    matches = false;
                }
            }
        }
        // Любая feature-зависимая ветка считается невыполненной.
        if !rule.features.is_empty() && rule.features.values().any(|v| *v) {
            matches = false;
        }
        if matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

/// Классификатор нативной библиотеки для текущей ОС (старый формат).
pub fn native_classifier(lib: &Library) -> Option<String> {
    let key = lib.natives.get(os_name())?;
    Some(key.replace("${arch}", if cfg!(target_pointer_width = "64") { "64" } else { "32" }))
}

/// Является ли библиотека нативной по новому формату (`...:natives-macos-arm64`).
pub fn is_modern_native(lib: &Library) -> bool {
    lib.name.contains(":natives-")
}

impl VersionJson {
    /// Наследование forge/fabric-профиля от ванильной версии.
    pub fn merge_with_parent(child: &VersionJson, parent: &VersionJson) -> VersionJson {
        let mut merged = parent.clone();
        merged.id = child.id.clone();
        merged.inherits_from = None;
        if child.main_class.is_some() {
            merged.main_class = child.main_class.clone();
        }
        if child.asset_index.is_some() {
            merged.asset_index = child.asset_index.clone();
        }
        if child.assets.is_some() {
            merged.assets = child.assets.clone();
        }
        if child.java_version.is_some() {
            merged.java_version = child.java_version.clone();
        }
        if child.kind.is_some() {
            merged.kind = child.kind.clone();
        }
        merged.jar = child.jar.clone().or(parent.jar.clone()).or(Some(parent.id.clone()));

        // Библиотеки лоадера идут первыми — они должны перекрывать ванильные.
        let mut libraries = child.libraries.clone();
        libraries.extend(parent.libraries.clone());
        merged.libraries = dedup_libraries(libraries);

        // Аргументы: сначала родительские, потом добавки лоадера.
        let mut arguments = parent.arguments.clone().unwrap_or_default();
        if let Some(child_args) = &child.arguments {
            arguments.game.extend(child_args.game.clone());
            arguments.jvm.extend(child_args.jvm.clone());
        }
        if arguments.game.is_empty() && arguments.jvm.is_empty() {
            merged.arguments = None;
        } else {
            merged.arguments = Some(arguments);
        }

        // Старый формат аргументов (до 1.13): лоадер задаёт свою строку целиком.
        if child.minecraft_arguments.is_some() {
            merged.minecraft_arguments = child.minecraft_arguments.clone();
        }
        merged
    }
}

/// Оставляет по одной библиотеке на `group:artifact[:classifier]`, побеждает первая.
fn dedup_libraries(libraries: Vec<Library>) -> Vec<Library> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for lib in libraries {
        let parts: Vec<&str> = lib.name.split(':').collect();
        let key = if parts.len() >= 4 {
            format!("{}:{}:{}", parts[0], parts[1], parts[3])
        } else if parts.len() >= 2 {
            format!("{}:{}", parts[0], parts[1])
        } else {
            lib.name.clone()
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(lib);
    }
    out
}

/// Читает version.json с диска, при отсутствии — тянет из манифеста Mojang.
pub async fn load_or_fetch_version(
    client: &Client,
    paths: &Paths,
    version_id: &str,
) -> Result<VersionJson> {
    let local = paths.version_json(version_id);
    if local.exists() {
        if let Ok(version) = read_json::<VersionJson>(&local) {
            if !version.id.is_empty() {
                return Ok(version);
            }
        }
    }
    let manifest: VersionManifest = get_json(client, VERSION_MANIFEST).await?;
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| Error::msg(format!("версия Minecraft {version_id} не найдена")))?;
    let value: Value = get_json(client, &entry.url).await?;
    write_json(&local, &value)?;
    Ok(serde_json::from_value(value)?)
}

/// Полностью разворачивает цепочку `inheritsFrom`.
pub async fn resolve_version(
    client: &Client,
    paths: &Paths,
    version_id: &str,
) -> Result<VersionJson> {
    let mut version = load_or_fetch_version(client, paths, version_id).await?;
    let mut depth = 0;
    while let Some(parent_id) = version.inherits_from.clone() {
        depth += 1;
        if depth > 8 {
            return Err(Error::msg("слишком длинная цепочка наследования версий"));
        }
        let parent = load_or_fetch_version(client, paths, &parent_id).await?;
        let parent = if parent.inherits_from.is_some() {
            Box::pin(resolve_version(client, paths, &parent_id)).await?
        } else {
            parent
        };
        version = VersionJson::merge_with_parent(&version, &parent);
    }
    Ok(version)
}

pub struct ResolvedLibraries {
    pub tasks: Vec<Task>,
    pub classpath: Vec<PathBuf>,
    /// Архивы, которые надо распаковать в natives/.
    pub natives: Vec<PathBuf>,
    /// Библиотеки, которые никто не раздаёт по HTTP (их кладёт установщик forge).
    pub local_only: Vec<PathBuf>,
}

/// Превращает список библиотек в задачи на скачивание + classpath.
pub fn resolve_libraries(version: &VersionJson, paths: &Paths) -> Result<ResolvedLibraries> {
    let lib_root = paths.libraries();
    let mut out = ResolvedLibraries {
        tasks: Vec::new(),
        classpath: Vec::new(),
        natives: Vec::new(),
        local_only: Vec::new(),
    };

    for lib in &version.libraries {
        if !rules_allow(&lib.rules) {
            continue;
        }

        let modern_native = is_modern_native(lib);
        let mut handled_native = false;

        // Старый формат: нативы лежат в classifiers.
        if let Some(classifier) = native_classifier(lib) {
            if let Some(downloads) = &lib.downloads {
                if let Some(artifact) = downloads.classifiers.get(&classifier) {
                    let rel = artifact
                        .path
                        .clone()
                        .map(PathBuf::from)
                        .unwrap_or(maven_to_path(&format!("{}:{}", lib.name, classifier))?);
                    let dest = lib_root.join(&rel);
                    out.tasks.push(
                        Task::new(artifact.url.clone(), dest.clone())
                            .with_hash(artifact.sha1.clone(), artifact.size),
                    );
                    out.natives.push(dest);
                    handled_native = true;
                }
            }
        }

        // Основной артефакт.
        let artifact = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());
        let rel = match artifact.and_then(|a| a.path.clone()) {
            Some(path) => PathBuf::from(path),
            None => maven_to_path(&lib.name)?,
        };
        let dest = lib_root.join(&rel);

        match artifact {
            Some(artifact) if !artifact.url.is_empty() => {
                out.tasks.push(
                    Task::new(artifact.url.clone(), dest.clone())
                        .with_hash(artifact.sha1.clone(), artifact.size),
                );
            }
            _ => {
                // Fabric/Forge задают только базовый репозиторий.
                if let Some(base) = &lib.url {
                    let base = if base.ends_with('/') {
                        base.clone()
                    } else {
                        format!("{base}/")
                    };
                    let url = format!("{base}{}", rel.to_string_lossy().replace('\\', "/"));
                    out.tasks.push(Task::new(url, dest.clone()));
                } else if artifact.is_none() {
                    let url = format!(
                        "{DEFAULT_LIB_REPO}{}",
                        rel.to_string_lossy().replace('\\', "/")
                    );
                    // Может не существовать — тогда файл принесёт установщик forge.
                    out.local_only.push(dest.clone());
                    out.tasks.push(Task::new(url, dest.clone()));
                }
            }
        }

        if modern_native && !handled_native {
            out.natives.push(dest.clone());
        }
        out.classpath.push(dest);
    }

    Ok(out)
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndex {
    pub objects: HashMap<String, AssetObject>,
    #[serde(default)]
    pub map_to_resources: bool,
    #[serde(default, rename = "virtual")]
    pub is_virtual: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

/// Скачивает индекс ассетов и отдаёт задачи на объекты.
pub async fn resolve_assets(
    client: &Client,
    paths: &Paths,
    version: &VersionJson,
) -> Result<(Vec<Task>, Option<(AssetIndex, String)>)> {
    let Some(index_ref) = &version.asset_index else {
        return Ok((Vec::new(), None));
    };

    let index_path = paths
        .assets()
        .join("indexes")
        .join(format!("{}.json", index_ref.id));
    if !index_path.exists() {
        let bytes = crate::download::get_bytes(client, &index_ref.url).await?;
        crate::util::ensure_parent(&index_path)?;
        std::fs::write(&index_path, &bytes)?;
    }

    let index: AssetIndex = read_json(&index_path)?;
    let objects_dir = paths.assets().join("objects");
    let mut tasks = Vec::with_capacity(index.objects.len());
    for object in index.objects.values() {
        let prefix = &object.hash[0..2];
        let dest = objects_dir.join(prefix).join(&object.hash);
        let url = format!("{RESOURCES}/{prefix}/{}", object.hash);
        tasks.push(Task::new(url, dest).with_hash(Some(object.hash.clone()), Some(object.size)));
    }

    Ok((tasks, Some((index, index_ref.id.clone()))))
}

/// Для версий 1.6–1.7: ассеты нужны в виде обычных файлов с именами.
pub fn materialize_virtual_assets(
    paths: &Paths,
    index: &AssetIndex,
    index_id: &str,
    instance_dir: &std::path::Path,
) -> Result<Option<PathBuf>> {
    if !index.is_virtual && !index.map_to_resources {
        return Ok(None);
    }
    let target = if index.map_to_resources {
        instance_dir.join("resources")
    } else {
        paths.assets().join("virtual").join(index_id)
    };

    for (name, object) in &index.objects {
        let source = paths
            .assets()
            .join("objects")
            .join(&object.hash[0..2])
            .join(&object.hash);
        let dest = target.join(name);
        if dest.exists() || !source.exists() {
            continue;
        }
        crate::util::ensure_parent(&dest)?;
        std::fs::copy(&source, &dest)?;
    }
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::maven_to_path;

    #[test]
    fn maven_coordinates() {
        assert_eq!(
            maven_to_path("net.fabricmc:fabric-loader:0.16.9").unwrap(),
            PathBuf::from("net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar")
        );
        assert_eq!(
            maven_to_path("org.lwjgl:lwjgl:3.3.3:natives-macos").unwrap(),
            PathBuf::from("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar")
        );
        assert_eq!(
            maven_to_path("de.oceanlabs.mcp:mcp_config:1.20.1@zip").unwrap(),
            PathBuf::from("de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip")
        );
    }

    #[test]
    fn os_rules() {
        let allow_current = vec![Rule {
            action: "allow".into(),
            os: Some(OsRule {
                name: Some(os_name().to_string()),
                ..Default::default()
            }),
            features: Default::default(),
        }];
        assert!(rules_allow(&allow_current));

        let other_os = vec![Rule {
            action: "allow".into(),
            os: Some(OsRule {
                name: Some("plan9".into()),
                ..Default::default()
            }),
            features: Default::default(),
        }];
        assert!(!rules_allow(&other_os));
        assert!(rules_allow(&[]));
    }

    /// Живая проверка по серверам Mojang и Fabric: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "требует сети"]
    async fn resolves_real_versions() {
        let temp = std::env::temp_dir().join("gandoni-test-root");
        let paths = Paths::new(temp);
        let client = reqwest::Client::new();

        let vanilla = resolve_version(&client, &paths, "1.20.1").await.unwrap();
        assert_eq!(vanilla.main_class.as_deref(), Some("net.minecraft.client.main.Main"));
        assert!(vanilla.asset_index.is_some());
        assert!(vanilla
            .downloads
            .as_ref()
            .and_then(|downloads| downloads.client.as_ref())
            .is_some());

        let libraries = resolve_libraries(&vanilla, &paths).unwrap();
        assert!(libraries.classpath.len() > 20);
        assert!(!libraries.natives.is_empty(), "нативы не нашлись");

        // Fabric должен унаследовать всё ванильное и добавить своё.
        let fabric_id = crate::fabric::install(&client, &paths, "1.20.1", None, false)
            .await
            .unwrap();
        let fabric = resolve_version(&client, &paths, &fabric_id).await.unwrap();
        assert_eq!(
            fabric.main_class.as_deref(),
            Some("net.fabricmc.loader.impl.launch.knot.KnotClient")
        );
        assert!(fabric.asset_index.is_some());
        assert!(fabric.libraries.len() > vanilla.libraries.len());
    }
}

/// Распаковывает нативные библиотеки в `versions/<id>/natives`.
pub fn extract_natives(archives: &[PathBuf], target: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(target)?;
    for archive_path in archives {
        if !archive_path.exists() {
            continue;
        }
        let file = std::fs::File::open(archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let Some(name) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            if entry.is_dir() {
                continue;
            }
            let name_str = name.to_string_lossy().replace('\\', "/");
            if name_str.starts_with("META-INF/") || name_str.contains("/META-INF/") {
                continue;
            }
            // Нас интересуют только собственно бинарники.
            let is_lib = name_str.ends_with(".dll")
                || name_str.ends_with(".so")
                || name_str.ends_with(".dylib")
                || name_str.ends_with(".jnilib");
            if !is_lib {
                continue;
            }
            let file_name = name.file_name().unwrap();
            let dest = target.join(file_name);
            if dest.exists() {
                continue;
            }
            let mut out = std::fs::File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}
