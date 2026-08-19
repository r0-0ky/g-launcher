import { createReadStream, existsSync } from "node:fs";
import { statSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import { config, r2Ready } from "../config.js";
import { queries } from "../db.js";
import { buildManifest } from "../manifest.js";
import { getSkin, skinUrl } from "../skins.js";
import { storagePath } from "../storage.js";
import { originOf } from "../util.js";

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  /** То, за чем ходит лаунчер. Кэш выключен: манифест должен меняться сразу. */
  app.get("/manifest.json", async (request, reply) => {
    reply.header("cache-control", "no-cache");
    return buildManifest(originOf(request));
  });

  /**
   * Скин по хэшу. Если у бакета R2 есть публичный адрес, отправляем игрока
   * прямо туда — трафик скинов идёт мимо нас.
   */
  app.get<{ Params: { file: string } }>("/skins/:file", async (request, reply) => {
    const match = /^([a-f0-9]{40})\.png$/i.exec(request.params.file);
    if (!match) return reply.code(400).send({ error: "нужен адрес вида <sha1>.png" });

    const sha1 = match[1].toLowerCase();
    if (r2Ready && config.r2PublicUrl) {
      return reply.redirect(`${config.r2PublicUrl}/skins/${sha1}.png`, 302);
    }

    const data = await getSkin(sha1);
    if (!data) return reply.code(404).send({ error: "скин не найден" });

    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("etag", `"${sha1}"`)
      .type("image/png")
      .send(data);
  });

  /** Скин по нику — этим адресом пользуются клиентские моды скинов. */
  app.get<{ Params: { name: string } }>("/skins/name/:name", async (request, reply) => {
    const name = request.params.name.replace(/\.png$/i, "");
    const account = queries.accountByName.get(name);
    if (!account?.skin_sha1) return reply.code(404).send({ error: "скин не найден" });

    // Кэш короткий: игрок может сменить скин в любой момент.
    return reply
      .header("cache-control", "public, max-age=60")
      .redirect(skinUrl(account.skin_sha1, originOf(request)), 302);
  });

  /** Раздача загруженных файлов. Содержимое привязано к хэшу, поэтому кэш вечный. */
  app.get<{ Params: { sha1: string; filename: string } }>(
    "/files/:sha1/:filename",
    async (request, reply) => {
      const { sha1, filename } = request.params;
      if (!/^[a-f0-9]{40}$/i.test(sha1)) {
        return reply.code(400).send({ error: "некорректный хэш" });
      }

      const path = storagePath(sha1.toLowerCase());
      if (!existsSync(path)) {
        return reply.code(404).send({ error: "файл не найден" });
      }

      const info = statSync(path);
      reply
        .header("content-type", "application/octet-stream")
        .header("content-length", info.size)
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("etag", `"${sha1}"`)
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
      return reply.send(createReadStream(path));
    }
  );
}
