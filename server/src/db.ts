import Database from "better-sqlite3";

import { ensureDataDirs, paths } from "./config.js";
import type { AccountRow, ModeFileRow, ModeInput, ModeRow } from "./types.js";

// Модуль открывает базу прямо при импорте, поэтому папки создаём здесь же:
// index.ts выполнится позже, чем эта строка.
ensureDataDirs();

export const db = new Database(paths.db);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS modes (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    version        TEXT,
    icon           TEXT,
    banner         TEXT,
    minecraft      TEXT NOT NULL,
    loader_type    TEXT NOT NULL DEFAULT 'vanilla',
    loader_version TEXT,
    java_major     INTEGER,
    memory_min     INTEGER,
    memory_max     INTEGER,
    server_host    TEXT,
    server_port    INTEGER,
    jvm_args       TEXT,
    sync_paths     TEXT NOT NULL DEFAULT '["mods","config","shaderpacks","resourcepacks"]',
    keep           TEXT NOT NULL DEFAULT '[]',
    visible        INTEGER NOT NULL DEFAULT 0,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mode_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mode_id     TEXT NOT NULL REFERENCES modes(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'other',
    url         TEXT NOT NULL,
    sha1        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    optional    INTEGER NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'upload',
    source_meta TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (mode_id, path)
  );

  -- Файлы адресуются по хэшу: один и тот же мод в трёх сборках лежит на диске один раз.
  CREATE TABLE IF NOT EXISTS uploads (
    sha1       TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mode_files_mode ON mode_files(mode_id);

  -- Аккаунт игрока. Заводится при первом входе через Telegram; id сразу служит
  -- UUID игрока в Minecraft, поэтому смена ника прогресс не теряет.
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    telegram_id   INTEGER NOT NULL UNIQUE,
    telegram_name TEXT,
    username      TEXT UNIQUE COLLATE NOCASE,
    skin_sha1     TEXT,
    skin_model    TEXT NOT NULL DEFAULT 'classic',
    banned        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Попытка входа: лаунчер выдаёт ссылку на бота, бот подтверждает её нажатием.
  CREATE TABLE IF NOT EXISTS login_attempts (
    token      TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Сессия игрока в лаунчере.
  CREATE TABLE IF NOT EXISTS account_sessions (
    token      TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_account ON account_sessions(account_id);
`);

const columns = {
  mode: `id, name, description, version, icon, banner, minecraft, loader_type, loader_version,
         java_major, memory_min, memory_max, server_host, server_port, jvm_args,
         sync_paths, keep, visible, sort_order, created_at, updated_at`,
};

export const queries = {
  allModes: db.prepare<[], ModeRow>(
    `SELECT ${columns.mode} FROM modes ORDER BY sort_order, name`
  ),
  visibleModes: db.prepare<[], ModeRow>(
    `SELECT ${columns.mode} FROM modes WHERE visible = 1 ORDER BY sort_order, name`
  ),
  modeById: db.prepare<[string], ModeRow>(
    `SELECT ${columns.mode} FROM modes WHERE id = ?`
  ),
  filesOfMode: db.prepare<[string], ModeFileRow>(
    `SELECT * FROM mode_files WHERE mode_id = ? ORDER BY kind, path`
  ),

  // --- Аккаунты игроков ---
  accountByTelegram: db.prepare<[number], AccountRow>(
    `SELECT * FROM accounts WHERE telegram_id = ?`
  ),
  accountById: db.prepare<[string], AccountRow>(`SELECT * FROM accounts WHERE id = ?`),
  accountByName: db.prepare<[string], AccountRow>(
    `SELECT * FROM accounts WHERE username = ? COLLATE NOCASE`
  ),
  allAccounts: db.prepare<[], AccountRow>(
    `SELECT * FROM accounts ORDER BY created_at DESC`
  ),
  insertAccount: db.prepare(
    `INSERT INTO accounts (id, telegram_id, telegram_name) VALUES (@id, @telegram_id, @telegram_name)`
  ),
  touchTelegramName: db.prepare(
    `UPDATE accounts SET telegram_name = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setUsername: db.prepare(
    `UPDATE accounts SET username = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setSkin: db.prepare(
    `UPDATE accounts SET skin_sha1 = ?, skin_model = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setBanned: db.prepare(
    `UPDATE accounts SET banned = ?, updated_at = datetime('now') WHERE id = ?`
  ),

  // --- Вход через бота ---
  createLogin: db.prepare(
    `INSERT INTO login_attempts (token, expires_at) VALUES (?, ?)`
  ),
  loginByToken: db.prepare<[string], { token: string; account_id: string | null; expires_at: string }>(
    `SELECT * FROM login_attempts WHERE token = ?`
  ),
  confirmLogin: db.prepare(
    `UPDATE login_attempts SET account_id = ? WHERE token = ?`
  ),
  dropLogin: db.prepare(`DELETE FROM login_attempts WHERE token = ?`),
  dropStaleLogins: db.prepare(`DELETE FROM login_attempts WHERE expires_at < datetime('now')`),

  // --- Сессии игроков ---
  createSession: db.prepare(
    `INSERT INTO account_sessions (token, account_id, expires_at) VALUES (?, ?, ?)`
  ),
  sessionByToken: db.prepare<[string], { token: string; account_id: string; expires_at: string }>(
    `SELECT * FROM account_sessions WHERE token = ?`
  ),
  dropSession: db.prepare(`DELETE FROM account_sessions WHERE token = ?`),
  dropStaleSessions: db.prepare(
    `DELETE FROM account_sessions WHERE expires_at < datetime('now')`
  ),
  fileById: db.prepare<[number], ModeFileRow>(`SELECT * FROM mode_files WHERE id = ?`),
  deleteFile: db.prepare(`DELETE FROM mode_files WHERE id = ?`),
  deleteMode: db.prepare(`DELETE FROM modes WHERE id = ?`),
  countFiles: db.prepare<[string], { count: number }>(
    `SELECT COUNT(*) AS count FROM mode_files WHERE mode_id = ?`
  ),
  upload: db.prepare<[string], { sha1: string; filename: string; size: number }>(
    `SELECT sha1, filename, size FROM uploads WHERE sha1 = ?`
  ),
  insertUpload: db.prepare(
    `INSERT OR IGNORE INTO uploads (sha1, filename, size) VALUES (?, ?, ?)`
  ),
  /** Ссылается ли на загруженный файл хоть одна сборка. */
  uploadUsage: db.prepare<[string], { count: number }>(
    `SELECT COUNT(*) AS count FROM mode_files WHERE sha1 = ? AND source = 'upload'`
  ),
  deleteUpload: db.prepare(`DELETE FROM uploads WHERE sha1 = ?`),
  insertFile: db.prepare(
    `INSERT INTO mode_files (mode_id, path, kind, url, sha1, size, optional, source, source_meta)
     VALUES (@mode_id, @path, @kind, @url, @sha1, @size, @optional, @source, @source_meta)
     ON CONFLICT (mode_id, path) DO UPDATE SET
       kind = excluded.kind, url = excluded.url, sha1 = excluded.sha1,
       size = excluded.size, source = excluded.source, source_meta = excluded.source_meta`
  ),
  setOptional: db.prepare(`UPDATE mode_files SET optional = ? WHERE id = ?`),
  touchMode: db.prepare(`UPDATE modes SET updated_at = datetime('now') WHERE id = ?`),
};

const insertMode = db.prepare(
  `INSERT INTO modes (
     id, name, description, version, icon, banner, minecraft, loader_type, loader_version,
     java_major, memory_min, memory_max, server_host, server_port, jvm_args,
     sync_paths, keep, visible, sort_order
   ) VALUES (
     @id, @name, @description, @version, @icon, @banner, @minecraft, @loader_type, @loader_version,
     @java_major, @memory_min, @memory_max, @server_host, @server_port, @jvm_args,
     @sync_paths, @keep, @visible, @sort_order
   )`
);

const updateMode = db.prepare(
  `UPDATE modes SET
     name = @name, description = @description, version = @version, icon = @icon, banner = @banner,
     minecraft = @minecraft, loader_type = @loader_type, loader_version = @loader_version,
     java_major = @java_major, memory_min = @memory_min, memory_max = @memory_max,
     server_host = @server_host, server_port = @server_port, jvm_args = @jvm_args,
     sync_paths = @sync_paths, keep = @keep, visible = @visible, sort_order = @sort_order,
     updated_at = datetime('now')
   WHERE id = @id`
);

function toRowParams(input: ModeInput) {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? "",
    version: input.version || null,
    icon: input.icon || null,
    banner: input.banner || null,
    minecraft: input.minecraft,
    loader_type: input.loaderType,
    loader_version: input.loaderVersion || null,
    java_major: input.javaMajor || null,
    memory_min: input.memoryMin || null,
    memory_max: input.memoryMax || null,
    server_host: input.serverHost || null,
    server_port: input.serverPort || null,
    jvm_args: input.jvmArgs || null,
    sync_paths: JSON.stringify(input.syncPaths ?? ["mods", "config", "shaderpacks", "resourcepacks"]),
    keep: JSON.stringify(input.keep ?? []),
    visible: input.visible ? 1 : 0,
    sort_order: input.sortOrder ?? 0,
  };
}

export function createMode(input: ModeInput): ModeRow {
  insertMode.run(toRowParams(input));
  return queries.modeById.get(input.id)!;
}

export function saveMode(input: ModeInput): ModeRow {
  updateMode.run(toRowParams(input));
  return queries.modeById.get(input.id)!;
}

/** Сколько сборок ссылается на загруженный файл — нужно перед удалением с диска. */
export function uploadIsOrphan(sha1: string): boolean {
  return (queries.uploadUsage.get(sha1)?.count ?? 0) === 0;
}
