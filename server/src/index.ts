import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { config } from "./config.js";
import { adminRoutes } from "./routes/admin.js";
import { downloadRoutes } from "./routes/download.js";
import { publicRoutes } from "./routes/public.js";

const here = dirname(fileURLToPath(import.meta.url));
const adminDist = resolve(here, "admin");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: config.maxUploadBytes, files: 50 },
});

await app.register(publicRoutes);
await app.register(downloadRoutes);
await app.register(adminRoutes, { prefix: "/api" });

// Собранная админка отдаётся тем же процессом — отдельный веб-сервер не нужен.
if (existsSync(join(adminDist, "index.html"))) {
  await app.register(fastifyStatic, { root: adminDist, prefix: "/admin/" });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  // SPA-роутинг: всё неизвестное под /admin отдаём index.html.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/admin")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "не найдено" });
  });
} else {
  app.log.warn("Админка не собрана: выполните npm run build");
}

// Корень домена — для игроков, а не для меня: отдаём страницу загрузки.
// Админка остаётся по прямой ссылке /admin.
app.get("/", async (_request, reply) => reply.redirect("/download"));

if (!config.adminPassword) {
  app.log.warn("ADMIN_PASSWORD пуст — вход в админку работать не будет");
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
