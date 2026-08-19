import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AwsClient } from "aws4fetch";

import { config, paths, r2Ready } from "./config.js";

/**
 * Хранилище скинов.
 *
 * Настроен R2 — файлы едут туда: скины отдаются игрокам постоянно, и гонять
 * этот трафик через VPS незачем. Ключей нет — кладём на диск рядом с модами,
 * чтобы можно было работать, не дожидаясь настройки бакета.
 *
 * Адресуются по sha1, как и остальные файлы: один и тот же скин у десяти
 * игроков занимает место один раз, а ссылка на него не устаревает.
 */

/** Скины крошечные: 64×64 в PNG весит пару килобайт. */
const MAX_BYTES = 200 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SkinShape {
  width: number;
  height: number;
}

/**
 * Проверяет, что это действительно PNG подходящего размера. Формат разбираем
 * сами: заголовок PNG фиксированный, ширина и высота лежат в блоке IHDR.
 */
export function inspectTexture(data: Buffer, kind: "skin" | "cape"): SkinShape | string {
  if (data.length > MAX_BYTES) return "файл больше 200 КБ";
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return "это не PNG";
  if (data.subarray(12, 16).toString("ascii") !== "IHDR") return "повреждённый PNG";

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);

  if (kind === "skin") {
    // 64×64 — современный скин, 64×32 — старый формат без второго слоя.
    if (width !== 64 || (height !== 64 && height !== 32)) {
      return `скин должен быть 64×64 или 64×32, а не ${width}×${height}`;
    }
    return { width, height };
  }

  // Плащ вдвое шире, чем выше: 64×32 у ванильного и вчетверо больше у чётких.
  const sizes = [64, 128, 256, 512];
  if (!sizes.includes(width) || height * 2 !== width) {
    return `плащ должен быть вдвое шире, чем выше (64×32, 128×64, 256×128 или 512×256), а не ${width}×${height}`;
  }
  return { width, height };
}

function keyOf(sha1: string): string {
  return `skins/${sha1}.png`;
}

function localPath(sha1: string): string {
  return join(paths.skins, `${sha1}.png`);
}

function r2() {
  return new AwsClient({
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    service: "s3",
    region: "auto",
  });
}

function r2Url(sha1: string): string {
  return `https://${config.r2AccountId}.r2.cloudflarestorage.com/${config.r2Bucket}/${keyOf(sha1)}`;
}

/** Кладёт скин в хранилище и возвращает его хэш. Повторная заливка бесплатна. */
export async function putSkin(data: Buffer): Promise<string> {
  const sha1 = createHash("sha1").update(data).digest("hex");

  if (r2Ready) {
    const response = await r2().fetch(r2Url(sha1), {
      method: "PUT",
      body: data,
      headers: {
        "content-type": "image/png",
        // Содержимое привязано к хэшу и не меняется — можно кэшировать вечно.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
    if (!response.ok) {
      throw new Error(`R2 ответил ${response.status} на загрузку скина`);
    }
    return sha1;
  }

  await mkdir(paths.skins, { recursive: true });
  await writeFile(localPath(sha1), data);
  return sha1;
}

/** Отдаёт содержимое скина. Пусто — значит такого хэша нет. */
export async function getSkin(sha1: string): Promise<Buffer | null> {
  if (r2Ready) {
    const response = await r2().fetch(r2Url(sha1));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 ответил ${response.status} на чтение скина`);
    return Buffer.from(await response.arrayBuffer());
  }

  try {
    return await readFile(localPath(sha1));
  } catch {
    return null;
  }
}

export async function dropSkin(sha1: string): Promise<void> {
  if (r2Ready) {
    await r2().fetch(r2Url(sha1), { method: "DELETE" });
    return;
  }
  await rm(localPath(sha1), { force: true });
}

/**
 * Адрес, по которому скин увидит игра. Если у бакета есть публичный адрес,
 * ведём прямо туда — тогда раздача идёт мимо нашего сервера.
 */
export function skinUrl(sha1: string, origin: string): string {
  if (r2Ready && config.r2PublicUrl) return `${config.r2PublicUrl}/${keyOf(sha1)}`;
  return `${origin}/skins/${sha1}.png`;
}
