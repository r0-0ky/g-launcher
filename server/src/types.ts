export type LoaderKind = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

/** Куда кладётся файл в папке игры — определяет и подпапку, и раздел в админке. */
export type ContentKind = "mod" | "shader" | "resourcepack" | "config" | "other";

export const CONTENT_DIRS: Record<ContentKind, string> = {
  mod: "mods",
  shader: "shaderpacks",
  resourcepack: "resourcepacks",
  config: "config",
  other: "",
};

export interface ModeRow {
  id: string;
  name: string;
  description: string;
  version: string | null;
  icon: string | null;
  banner: string | null;
  minecraft: string;
  loader_type: LoaderKind;
  loader_version: string | null;
  java_major: number | null;
  memory_min: number | null;
  memory_max: number | null;
  server_host: string | null;
  server_port: number | null;
  jvm_args: string | null;
  sync_paths: string;
  keep: string;
  visible: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ModeFileRow {
  id: number;
  mode_id: string;
  path: string;
  kind: ContentKind;
  url: string;
  sha1: string;
  size: number;
  optional: number;
  source: "upload" | "modrinth" | "url";
  source_meta: string | null;
  created_at: string;
}

export interface ModeInput {
  id: string;
  name: string;
  description?: string;
  version?: string | null;
  icon?: string | null;
  banner?: string | null;
  minecraft: string;
  loaderType: LoaderKind;
  loaderVersion?: string | null;
  javaMajor?: number | null;
  memoryMin?: number | null;
  memoryMax?: number | null;
  serverHost?: string | null;
  serverPort?: number | null;
  jvmArgs?: string | null;
  syncPaths?: string[];
  keep?: string[];
  visible?: boolean;
  sortOrder?: number;
}
