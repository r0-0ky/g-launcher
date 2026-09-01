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
  /**
   * Репозиторий вида `owner/repo` — из его релизов берётся страница /download.
   * По умолчанию наш: без переменной страница загрузок молча оставалась пустой.
   */
  githubRepo: (process.env.GITHUB_REPO ?? "r0-0ky/g-launcher").trim(),
  /** Необязательный токен: поднимает лимит GitHub API с 60 до 5000 запросов в час. */
  githubToken: (process.env.GITHUB_TOKEN ?? "").trim(),
  /**
   * Максимальный размер загружаемого файла. По умолчанию не ограничен: сборки
   * с тяжёлыми модами упирались в потолок на ровном месте. `MAX_UPLOAD_MB`
   * задаёт предел, если он всё же нужен, — например под лимит прокси впереди.
   */
  maxUploadBytes:
    Number(process.env.MAX_UPLOAD_MB) > 0
      ? Number(process.env.MAX_UPLOAD_MB) * 1024 * 1024
      : Infinity,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS ?? 24) * 3600 * 1000,

  /** Бот, через которого игроки входят: токен от @BotFather. */
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
  /** Имя бота без «@» — из него собирается ссылка входа. */
  telegramBotName: (process.env.TELEGRAM_BOT_NAME ?? "").trim().replace(/^@/, ""),
  /**
   * Секрет вебхука: Telegram присылает его заголовком, чужие запросы отсекаются.
   * Пусто — сгенерируем свой при старте, но тогда вебхук надо ставить самим.
   */
  telegramWebhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim(),
  /**
   * Можно ли игрокам заливать свои скины и плащи. Выключено — косметика
   * берётся только из магазина, и заливать может лишь админка.
   */
  allowPlayerUploads: (process.env.ALLOW_PLAYER_UPLOADS ?? "true").toLowerCase() !== "false",

  /** Сколько живёт сессия игрока в лаунчере. */
  accountSessionTtlMs: Number(process.env.ACCOUNT_SESSION_TTL_DAYS ?? 30) * 86400 * 1000,

  /** Cloudflare R2 для скинов. Не задан — скины лягут на диск сервера. */
  r2AccountId: (process.env.R2_ACCOUNT_ID ?? "").trim(),
  r2Bucket: (process.env.R2_BUCKET ?? "").trim(),
  r2AccessKeyId: (process.env.R2_ACCESS_KEY_ID ?? "").trim(),
  r2SecretAccessKey: (process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
  /**
   * Публичный адрес бакета (r2.dev или свой домен). Если задан, игроков за
   * скинами отправляем прямо туда, и трафик мимо нас.
   */
  r2PublicUrl: (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, ""),
};

/** R2 включается, только когда заданы все четыре значения. */
export const r2Ready = Boolean(
  config.r2AccountId && config.r2Bucket && config.r2AccessKeyId && config.r2SecretAccessKey
);

/** Вход через Telegram включается, только если бот настроен целиком. */
export const telegramReady = Boolean(config.telegramBotToken && config.telegramBotName);

export const paths = {
  db: resolve(config.dataDir, "gandoni.db"),
  files: resolve(config.dataDir, "files"),
  /** Запасное хранилище скинов, когда R2 не настроен. */
  skins: resolve(config.dataDir, "skins"),
};

export function ensureDataDirs(): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(paths.files, { recursive: true });
  mkdirSync(paths.skins, { recursive: true });
}
