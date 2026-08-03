import type { FastifyRequest } from "fastify";

import { config } from "./config.js";
import { CONTENT_DIRS, type ContentKind } from "./types.js";

/** Базовый адрес для ссылок в манифесте. */
export function originOf(request: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const proto = (request.headers["x-forwarded-proto"] as string) ?? request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) ?? request.headers.host ?? "";
  return `${proto}://${host}`;
}

export function isValidModeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,48}$/.test(id);
}

// Символы, недопустимые в именах файлов Windows, плюс управляющие.
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f<>:"|?*\\/]/g;

/** Имя файла без путей и сюрпризов вроде `../`. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, "").replace(/^\.+/, "").trim();
  return cleaned || "file";
}

/** Куда положить файл в папке игры, исходя из его типа. */
export function targetPath(kind: ContentKind, filename: string): string {
  const dir = CONTENT_DIRS[kind];
  const safe = safeFilename(filename);
  return dir ? `${dir}/${safe}` : safe;
}

export function slugify(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  return value
    .toLowerCase()
    .split("")
    .map((char) => map[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
