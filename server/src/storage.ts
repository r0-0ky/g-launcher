import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import { paths } from "./config.js";
import { queries, uploadIsOrphan } from "./db.js";

/** Файлы лежат по хэшу: files/ab/abcdef… — дубликаты между сборками не занимают место. */
export function storagePath(sha1: string): string {
  return join(paths.files, sha1.slice(0, 2), sha1);
}

export function publicPath(sha1: string, filename: string): string {
  return `/files/${sha1}/${encodeURIComponent(filename)}`;
}

export interface StoredFile {
  sha1: string;
  size: number;
  filename: string;
  url: string;
  alreadyExisted: boolean;
}

/** Принимает поток загрузки, считает sha1 и кладёт файл в хранилище. */
export async function storeStream(stream: Readable, filename: string): Promise<StoredFile> {
  const tempPath = join(paths.files, `.tmp-${randomBytes(8).toString("hex")}`);
  const hash = createHash("sha1");
  let size = 0;

  stream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });

  await pipeline(stream, createWriteStream(tempPath));

  const sha1 = hash.digest("hex");
  const target = storagePath(sha1);

  let alreadyExisted = true;
  try {
    await stat(target);
    await rm(tempPath, { force: true });
  } catch {
    await mkdir(dirname(target), { recursive: true });
    await rename(tempPath, target);
    alreadyExisted = false;
  }

  queries.insertUpload.run(sha1, filename, size);

  return { sha1, size, filename, url: publicPath(sha1, filename), alreadyExisted };
}

/** Удаляет файл с диска, если на него больше никто не ссылается. */
export async function collectGarbage(sha1: string): Promise<void> {
  if (!uploadIsOrphan(sha1)) return;
  await rm(storagePath(sha1), { force: true });
  queries.deleteUpload.run(sha1);
}
