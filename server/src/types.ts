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

/** Аккаунт игрока: заводится при первом входе через Telegram. */
export interface AccountRow {
  /** UUID без дефисов — он же UUID игрока в Minecraft. */
  id: string;
  telegram_id: number;
  telegram_name: string | null;
  /** Игровой ник. Пусто, пока игрок его не выбрал. */
  username: string | null;
  skin_sha1: string | null;
  skin_model: "classic" | "slim";
  /** Активный плащ. Появился позже скина, поэтому может отсутствовать. */
  cape_sha1?: string | null;
  banned: number;
  /** Кошелёк в G-коинах. */
  coins?: number;
  created_at: string;
  updated_at: string;
}

/** Одна залитая текстура в библиотеке игрока. */
export interface TextureRow {
  id: number;
  account_id: string;
  kind: "skin" | "cape";
  sha1: string;
  model: "classic" | "slim";
  created_at: string;
}

/** Качество вещи: цвет рамки и порядок редкости. */
export type Rarity = "green" | "blue" | "purple" | "legendary";

export const RARITIES: Rarity[] = ["green", "blue", "purple", "legendary"];

/** Позиция витрины. */
export interface ShopItemRow {
  id: number;
  kind: "skin" | "cape";
  name: string;
  price: number;
  sha1: string;
  model: "classic" | "slim";
  /** Качество: от зелёного к легендарному. */
  rarity: Rarity;
  visible: number;
  sort_order: number;
  created_at: string;
}
