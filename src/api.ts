import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LoaderKind = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

export interface ModeFile {
  path: string;
  url: string;
  sha1?: string;
  size?: number;
  optional?: boolean;
}

export interface Mode {
  id: string;
  name: string;
  description: string;
  version?: string;
  icon?: string;
  banner?: string;
  minecraft: string;
  loader: { type: LoaderKind; version?: string };
  java?: { major: number; component?: string };
  memory: { min?: number; max?: number };
  server?: { host: string; port: number };
  files: ModeFile[];
  syncPaths: string[];
  keep: string[];
  jvmArgs?: string;
}

export interface Manifest {
  schema: number;
  updated?: string;
  news?: string;
  modes: Mode[];
}

export interface Settings {
  manifestUrl: string;
  rootDir: string | null;
  memoryMb: number;
  javaPath: string | null;
  jvmArgs: string;
  msClientId: string;
  fullscreen: boolean;
  closeLauncherOnStart: boolean;
  autoConnect: boolean;
  lastMode: string | null;
}

export interface Account {
  id: string;
  kind: "offline" | "microsoft" | "gland";
  /** Картинка предмета вместо аватарки — приходит с сервера при регистрации. */
  avatar?: string | null;
  username: string;
  uuid: string;
}

export interface Bootstrap {
  settings: Settings;
  accounts: Account[];
  activeAccount: string | null;
  gameRoot: string;
  manifest: Manifest | null;
}

export interface UpdateReport {
  modeId: string;
  installed: boolean;
  needsUpdate: boolean;
  filesToDownload: number;
  filesToDelete: number;
  downloadBytes: number;
  deleteNames: string[];
}

export interface ProgressEvent {
  mode: string;
  stage: string;
  message: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  percent: number;
  done: boolean;
}

export interface GameStateEvent {
  mode: string;
  running: boolean;
  exitCode: number | null;
  message: string;
}

export interface LogEvent {
  line: string;
  error: boolean;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface Texture {
  id: number;
  kind: "skin" | "cape";
  model: "classic" | "slim";
  /** Адрес картинки — по нему рисуется превью. */
  url: string;
  /** Надета ли она сейчас. */
  active: boolean;
}

export interface ShopItem {
  id: number;
  kind: "skin" | "cape";
  name: string;
  price: number;
  model: "classic" | "slim";
  /** Качество: от зелёного к легендарному. */
  rarity: "green" | "blue" | "purple" | "legendary";
  url: string;
  owned: boolean;
}

export interface Shop {
  coins: number;
  /** Скин игрока — на нём показываем плащи с витрины. */
  wearing: { skin: string; model: "classic" | "slim" };
  items: ShopItem[];
}

export interface Library {
  profile: {
    id: string;
    username: string | null;
    skinModel: "classic" | "slim";
    hasSkin: boolean;
    hasCape: boolean;
    /** Кошелёк в G-коинах. */
    coins: number;
    /** Заливка своих текстур может быть закрыта — тогда прячем кнопки. */
    canUpload: boolean;
    /** Стандартный скин Minecraft: его видно, пока свой не надет. */
    defaultSkin: { name: string; model: "classic" | "slim"; url: string };
  };
  skins: Texture[];
  capes: Texture[];
}

/** Тариф пополнения кошелька: сколько коинов за сколько рублей. */
export interface CoinPack {
  id: number;
  name: string;
  coins: number;
  /** Целыми рублями. */
  price: number;
  /** Плашка вроде «выгодно». Пусто — плашки нет. */
  badge: string | null;
}

export interface CoinPacks {
  /** Приём карт настроен на сервере. Нет — показывать нечего. */
  available: boolean;
  coins: number;
  packs: CoinPack[];
}

/** Начатая оплата: ссылку открываем в браузере, по id узнаём, чем кончилось. */
export interface PaymentStart {
  id: string;
  url: string;
}

export interface PaymentStatus {
  id: string;
  status: "pending" | "paid" | "failed";
  coins: number;
  /** Кошелёк после начисления. */
  balance: number;
}

export interface GLandLogin {
  /** Одноразовый код: по нему лаунчер опрашивает сервер. */
  token: string;
  /** Ссылка на бота — её открываем в браузере. */
  url: string;
  expiresIn: number;
}

export const api = {
  bootstrap: () => invoke<Bootstrap>("get_bootstrap"),
  saveSettings: (settings: Settings) => invoke<Bootstrap>("save_settings", { settings }),
  fetchManifest: (force = false) => invoke<Manifest>("fetch_manifest", { force }),
  checkUpdates: (modeId: string, verify = false) =>
    invoke<UpdateReport>("check_updates", { modeId, verify }),
  install: (modeId: string, verify = false) => invoke<void>("install_mode", { modeId, verify }),
  play: (modeId: string, verify = false) => invoke<void>("play", { modeId, verify }),
  stopGame: () => invoke<void>("stop_game"),
  isGameRunning: () => invoke<boolean>("is_game_running"),
  /** Вход через наш сервер: ссылка на бота, потом опрос до подтверждения. */
  glandLoginStart: () => invoke<GLandLogin>("gland_login_start"),
  glandLoginPoll: (token: string) => invoke<Bootstrap | null>("gland_login_poll", { token }),
  glandSetNickname: (username: string) =>
    invoke<Bootstrap>("gland_set_nickname", { username }),
  /** Библиотека текстур: что залито и что надето. */
  glandTextures: () => invoke<Library>("gland_textures"),
  glandUploadTexture: (path: string, kind: "skin" | "cape", model: "classic" | "slim") =>
    invoke<Library>("gland_upload_texture", { path, kind, model }),
  glandSetModel: (model: "classic" | "slim") => invoke<Library>("gland_set_model", { model }),
  /** Магазин: витрина и покупка за G-коины. */
  glandShop: () => invoke<Shop>("gland_shop"),
  glandBuy: (id: number) => invoke<Library>("gland_buy", { id }),
  /** Пополнение кошелька: тарифы, оплата картой и опрос её исхода. */
  glandCoinPacks: () => invoke<CoinPacks>("gland_coin_packs"),
  glandBuyCoins: (pack: number) => invoke<PaymentStart>("gland_buy_coins", { pack }),
  glandPaymentStatus: (id: string) => invoke<PaymentStatus>("gland_payment_status", { id }),
  glandSelectTexture: (id: number) => invoke<Library>("gland_select_texture", { id }),
  glandClearTexture: (kind: "skin" | "cape") =>
    invoke<Library>("gland_clear_texture", { kind }),
  glandDeleteTexture: (id: number) => invoke<Library>("gland_delete_texture", { id }),
  addOfflineAccount: (username: string) =>
    invoke<Bootstrap>("add_offline_account", { username }),
  msLoginStart: () => invoke<DeviceCode>("ms_login_start"),
  msLoginPoll: (deviceCode: string) =>
    invoke<Bootstrap | null>("ms_login_poll", { deviceCode }),
  setActiveAccount: (id: string) => invoke<Bootstrap>("set_active_account", { id }),
  removeAccount: (id: string) => invoke<Bootstrap>("remove_account", { id }),
  openModeFolder: (modeId: string) => invoke<void>("open_mode_folder", { modeId }),
  openGameRoot: () => invoke<void>("open_game_root"),
  deleteMode: (modeId: string) => invoke<void>("delete_mode", { modeId }),
};

export const events = {
  onProgress: (handler: (event: ProgressEvent) => void): Promise<UnlistenFn> =>
    listen<ProgressEvent>("install://progress", (event) => handler(event.payload)),
  onGameState: (handler: (event: GameStateEvent) => void): Promise<UnlistenFn> =>
    listen<GameStateEvent>("game://state", (event) => handler(event.payload)),
  onLog: (handler: (event: LogEvent) => void): Promise<UnlistenFn> =>
    listen<LogEvent>("game://log", (event) => handler(event.payload)),
};

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function loaderLabel(mode: Mode): string {
  const names: Record<LoaderKind, string> = {
    vanilla: "Ванилла",
    fabric: "Fabric",
    quilt: "Quilt",
    forge: "Forge",
    neoforge: "NeoForge",
  };
  const kind = mode.loader?.type ?? "vanilla";
  const version = mode.loader?.version;
  return version && version !== "latest" ? `${names[kind]} ${version}` : names[kind];
}

/** Ошибки из Rust приходят строкой, но на всякий случай нормализуем. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
