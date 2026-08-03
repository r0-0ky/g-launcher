import { createReadStream, existsSync } from "node:fs";
import { statSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import { buildManifest } from "../manifest.js";
import { storagePath } from "../storage.js";
import { originOf } from "../util.js";

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  /** То, за чем ходит лаунчер. Кэш выключен: манифест должен меняться сразу. */
  app.get("/manifest.json", async (request, reply) => {
    reply.header("cache-control", "no-cache");
    return buildManifest(originOf(request));
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
