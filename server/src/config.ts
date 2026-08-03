import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Все настройки берутся из окружения — так удобнее в Docker. */
export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  /** Куда складывать базу и загруженные файлы. */
  dataDir: resolve(process.env.DATA_DIR ?? "./data"),
  /** Пароль входа в админку. Обязателен. */
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  /**
   * Публичный адрес сервера — попадает в ссылки манифеста.
   * Если пусто, берётся из заголовков запроса.
   */
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  /** Репозиторий вида `owner/repo` — из его релизов берётся страница /download. */
  githubRepo: (process.env.GITHUB_REPO ?? "").trim(),
  /** Необязательный токен: поднимает лимит GitHub API с 60 до 5000 запросов в час. */
  githubToken: (process.env.GITHUB_TOKEN ?? "").trim(),
  /** Максимальный размер загружаемого файла. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 512) * 1024 * 1024,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS ?? 24) * 3600 * 1000,
};

export const paths = {
  db: resolve(config.dataDir, "gandoni.db"),
  files: resolve(config.dataDir, "files"),
};

export function ensureDataDirs(): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
}
