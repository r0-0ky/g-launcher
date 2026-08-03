import { queries } from "./db.js";
import type { ModeFileRow, ModeRow } from "./types.js";

/** Формат, который читает лаунчер (см. src-tauri/src/manifest.rs). */
export interface ManifestMode {
  id: string;
  name: string;
  description: string;
  version?: string;
  icon?: string;
  banner?: string;
  minecraft: string;
  loader: { type: string; version?: string };
  java?: { major: number };
  memory?: { min?: number; max?: number };
  server?: { host: string; port: number };
  jvmArgs?: string;
  syncPaths: string[];
  keep: string[];
  files: Array<{
    path: string;
    url: string;
    sha1: string;
    size: number;
    optional?: boolean;
  }>;
}

function parseList(value: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Внутри БД ссылки на свои файлы хранятся относительными. */
export function absoluteUrl(url: string, origin: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function modeToManifest(mode: ModeRow, files: ModeFileRow[], origin: string): ManifestMode {
  const result: ManifestMode = {
    id: mode.id,
    name: mode.name,
    description: mode.description,
    minecraft: mode.minecraft,
    loader: { type: mode.loader_type },
    syncPaths: parseList(mode.sync_paths, ["mods"]),
    keep: parseList(mode.keep, []),
    files: files.map((file) => ({
      path: file.path,
      url: absoluteUrl(file.url, origin),
      sha1: file.sha1,
      size: file.size,
      ...(file.optional ? { optional: true } : {}),
    })),
  };

  if (mode.loader_version) result.loader.version = mode.loader_version;
  if (mode.version) result.version = mode.version;
  if (mode.icon) result.icon = absoluteUrl(mode.icon, origin);
  if (mode.banner) result.banner = absoluteUrl(mode.banner, origin);
  if (mode.java_major) result.java = { major: mode.java_major };
  if (mode.memory_min || mode.memory_max) {
    result.memory = {
      ...(mode.memory_min ? { min: mode.memory_min } : {}),
      ...(mode.memory_max ? { max: mode.memory_max } : {}),
    };
  }
  if (mode.server_host) {
    result.server = { host: mode.server_host, port: mode.server_port ?? 25565 };
  }
  if (mode.jvm_args) result.jvmArgs = mode.jvm_args;

  return result;
}

/** Публичный манифест: только сборки, помеченные видимыми. */
export function buildManifest(origin: string, includeHidden = false) {
  const modes = includeHidden ? queries.allModes.all() : queries.visibleModes.all();
  const updated = modes.reduce<string>(
    (latest, mode) => (mode.updated_at > latest ? mode.updated_at : latest),
    "1970-01-01 00:00:00"
  );

  return {
    schema: 1,
    updated: new Date(`${updated.replace(" ", "T")}Z`).toISOString(),
    modes: modes.map((mode) =>
      modeToManifest(mode, queries.filesOfMode.all(mode.id), origin)
    ),
  };
}
