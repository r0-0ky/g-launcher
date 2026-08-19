import type { FastifyInstance } from "fastify";

import { login, logout, requireAuth } from "../auth.js";
import { createMode, db, queries, saveMode } from "../db.js";
import { loaderVersions, minecraftVersions } from "../loaders.js";
import { buildManifest } from "../manifest.js";
import * as modrinth from "../modrinth.js";
import { inspectTexture, putSkin, skinUrl } from "../skins.js";
import { collectGarbage, storeStream } from "../storage.js";
import { RARITIES } from "../types.js";
import type { ContentKind, ModeInput, ModeRow, Rarity } from "../types.js";
import { isValidModeId, originOf, safeFilename, targetPath } from "../util.js";

const KINDS: ContentKind[] = ["mod", "shader", "resourcepack", "config", "other"];

function parseKind(value: unknown): ContentKind {
  return KINDS.includes(value as ContentKind) ? (value as ContentKind) : "other";
}

function modeToInput(row: ModeRow): ModeInput {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    icon: row.icon,
    banner: row.banner,
    minecraft: row.minecraft,
    loaderType: row.loader_type,
    loaderVersion: row.loader_version,
    javaMajor: row.java_major,
    memoryMin: row.memory_min,
    memoryMax: row.memory_max,
    serverHost: row.server_host,
    serverPort: row.server_port,
    jvmArgs: row.jvm_args,
    syncPaths: JSON.parse(row.sync_paths),
    keep: JSON.parse(row.keep),
    visible: row.visible === 1,
    sortOrder: row.sort_order,
  };
}

/** Движение монет всегда парой: сам кошелёк и запись в историю. */
const grant = db.transaction((accountId: string, delta: number, reason: string) => {
  queries.addCoins.run(delta, accountId);
  queries.writeLedger.run(accountId, delta, reason);
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { password?: string } }>("/login", async (request, reply) => {
    const token = login(request.body?.password ?? "");
    if (!token) return reply.code(401).send({ error: "Неверный пароль" });
    return { token };
  });

  // Всё ниже — только для администратора.
  app.register(async (secured) => {
    secured.addHook("preHandler", requireAuth);

    secured.post("/logout", async (request) => {
      const header = request.headers.authorization ?? "";
      logout(header.startsWith("Bearer ") ? header.slice(7) : "");
      return { ok: true };
    });

    secured.get("/session", async () => ({ ok: true }));

    // --- Справочники ---

    secured.get("/minecraft/versions", async () => minecraftVersions());

    secured.get<{ Querystring: { loader?: string; minecraft?: string } }>(
      "/loader/versions",
      async (request) =>
        loaderVersions(request.query.loader ?? "", request.query.minecraft ?? "")
    );

    // --- Сборки ---

    secured.get("/modes", async (request) => {
      const origin = originOf(request);
      return queries.allModes.all().map((mode) => ({
        ...modeToInput(mode),
        filesCount: queries.countFiles.get(mode.id)?.count ?? 0,
        updatedAt: mode.updated_at,
        manifestUrl: `${origin}/manifest.json`,
      }));
    });

    secured.get<{ Params: { id: string } }>("/modes/:id", async (request, reply) => {
      const mode = queries.modeById.get(request.params.id);
      if (!mode) return reply.code(404).send({ error: "Сборка не найдена" });
      return {
        ...modeToInput(mode),
        files: queries.filesOfMode.all(mode.id).map((file) => ({
          id: file.id,
          path: file.path,
          kind: file.kind,
          url: file.url,
          sha1: file.sha1,
          size: file.size,
          optional: file.optional === 1,
          source: file.source,
          meta: file.source_meta ? JSON.parse(file.source_meta) : null,
        })),
      };
    });

    secured.post<{ Body: ModeInput }>("/modes", async (request, reply) => {
      const input = request.body;
      if (!isValidModeId(input?.id ?? "")) {
        return reply
          .code(400)
          .send({ error: "id: латиница, цифры, дефис; от 2 до 49 символов" });
      }
      if (queries.modeById.get(input.id)) {
        return reply.code(409).send({ error: "Сборка с таким id уже есть" });
      }
      if (!input.name?.trim() || !input.minecraft?.trim()) {
        return reply.code(400).send({ error: "Нужны название и версия Minecraft" });
      }
      return modeToInput(createMode(input));
    });

    secured.put<{ Params: { id: string }; Body: ModeInput }>(
      "/modes/:id",
      async (request, reply) => {
        const existing = queries.modeById.get(request.params.id);
        if (!existing) return reply.code(404).send({ error: "Сборка не найдена" });
        const input = { ...request.body, id: request.params.id };
        if (!input.name?.trim() || !input.minecraft?.trim()) {
          return reply.code(400).send({ error: "Нужны название и версия Minecraft" });
        }
        return modeToInput(saveMode(input));
      }
    );

    secured.delete<{ Params: { id: string } }>("/modes/:id", async (request, reply) => {
      const mode = queries.modeById.get(request.params.id);
      if (!mode) return reply.code(404).send({ error: "Сборка не найдена" });

      const files = queries.filesOfMode.all(mode.id);
      queries.deleteMode.run(mode.id);
      for (const file of files) {
        if (file.source === "upload") await collectGarbage(file.sha1);
      }
      return { ok: true };
    });

    /** Клон сборки со всем содержимым — удобно делать сезонные версии. */
    secured.post<{ Params: { id: string }; Body: { id: string; name?: string } }>(
      "/modes/:id/duplicate",
      async (request, reply) => {
        const source = queries.modeById.get(request.params.id);
        if (!source) return reply.code(404).send({ error: "Сборка не найдена" });
        const newId = request.body?.id ?? "";
        if (!isValidModeId(newId)) return reply.code(400).send({ error: "Некорректный id" });
        if (queries.modeById.get(newId)) {
          return reply.code(409).send({ error: "Сборка с таким id уже есть" });
        }

        const input = modeToInput(source);
        const created = createMode({
          ...input,
          id: newId,
          name: request.body?.name || `${source.name} (копия)`,
          visible: false,
        });

        const copy = db.transaction(() => {
          for (const file of queries.filesOfMode.all(source.id)) {
            queries.insertFile.run({
              mode_id: newId,
              path: file.path,
              kind: file.kind,
              url: file.url,
              sha1: file.sha1,
              size: file.size,
              optional: file.optional,
              source: file.source,
              source_meta: file.source_meta,
            });
          }
        });
        copy();

        return modeToInput(created);
      }
    );

    // --- Содержимое сборки ---

    /** Загрузка своих файлов: jar-ы, конфиги, паки. Поддерживает несколько сразу. */
    secured.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
      "/modes/:id/files/upload",
      async (request, reply) => {
        const mode = queries.modeById.get(request.params.id);
        if (!mode) return reply.code(404).send({ error: "Сборка не найдена" });

        const kind = parseKind(request.query.kind);
        const added: Array<{ path: string; size: number }> = [];

        for await (const part of request.parts()) {
          if (part.type !== "file") continue;
          const filename = safeFilename(part.filename);
          const stored = await storeStream(part.file, filename);
          const path = targetPath(kind, filename);

          queries.insertFile.run({
            mode_id: mode.id,
            path,
            kind,
            url: stored.url,
            sha1: stored.sha1,
            size: stored.size,
            optional: 0,
            source: "upload",
            source_meta: null,
          });
          added.push({ path, size: stored.size });
        }

        if (added.length === 0) {
          return reply.code(400).send({ error: "В запросе нет файлов" });
        }
        queries.touchMode.run(mode.id);
        return { added };
      }
    );

    /** Добавление мода/шейдера/пака прямо из каталога Modrinth. */
    secured.post<{
      Params: { id: string };
      Body: {
        projectId: string;
        versionId?: string;
        type: modrinth.ProjectType;
        withDependencies?: boolean;
      };
    }>("/modes/:id/files/modrinth", async (request, reply) => {
      const mode = queries.modeById.get(request.params.id);
      if (!mode) return reply.code(404).send({ error: "Сборка не найдена" });

      const { projectId, versionId, type, withDependencies } = request.body ?? {};
      if (!projectId || !type) {
        return reply.code(400).send({ error: "Нужны projectId и type" });
      }

      const kind: ContentKind =
        type === "shader" ? "shader" : type === "resourcepack" ? "resourcepack" : "mod";

      const added: string[] = [];
      const seenProjects = new Set<string>();

      const addProject = async (
        id: string,
        wantedVersionId: string | undefined,
        projectKind: ContentKind,
        projectType: modrinth.ProjectType
      ): Promise<string[]> => {
        if (seenProjects.has(id)) return [];
        seenProjects.add(id);

        const list = await modrinth.versions(
          id,
          projectType,
          mode.minecraft,
          mode.loader_type
        );
        const chosen = wantedVersionId
          ? list.find((item) => item.versionId === wantedVersionId) ?? list[0]
          : list[0];
        if (!chosen) {
          throw new Error(
            `для этой сборки (${mode.minecraft}/${mode.loader_type}) нет подходящей версии`
          );
        }

        const info = await modrinth.project(id).catch(() => null);
        queries.insertFile.run({
          mode_id: mode.id,
          path: targetPath(projectKind, chosen.filename),
          kind: projectKind,
          url: chosen.url,
          sha1: chosen.sha1,
          size: chosen.size,
          optional: 0,
          source: "modrinth",
          source_meta: JSON.stringify({
            projectId: id,
            versionId: chosen.versionId,
            versionNumber: chosen.versionNumber,
            title: info?.title ?? chosen.name,
            iconUrl: info?.iconUrl ?? null,
          }),
        });
        added.push(targetPath(projectKind, chosen.filename));

        // Обязательные зависимости тянем следом — иначе игра просто не запустится.
        if (withDependencies) {
          for (const dep of chosen.dependencies) {
            if (dep.type !== "required" || !dep.projectId) continue;
            await addProject(dep.projectId, dep.versionId ?? undefined, "mod", "mod").catch(
              () => []
            );
          }
        }
        return added;
      };

      try {
        await addProject(projectId, versionId, kind, type);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      queries.touchMode.run(mode.id);
      return { added };
    });

    secured.patch<{
      Params: { id: string; fileId: string };
      Body: { optional?: boolean };
    }>("/modes/:id/files/:fileId", async (request, reply) => {
      const file = queries.fileById.get(Number(request.params.fileId));
      if (!file || file.mode_id !== request.params.id) {
        return reply.code(404).send({ error: "Файл не найден" });
      }
      queries.setOptional.run(request.body?.optional ? 1 : 0, file.id);
      queries.touchMode.run(file.mode_id);
      return { ok: true };
    });

    secured.delete<{ Params: { id: string; fileId: string } }>(
      "/modes/:id/files/:fileId",
      async (request, reply) => {
        const file = queries.fileById.get(Number(request.params.fileId));
        if (!file || file.mode_id !== request.params.id) {
          return reply.code(404).send({ error: "Файл не найден" });
        }
        queries.deleteFile.run(file.id);
        if (file.source === "upload") await collectGarbage(file.sha1);
        queries.touchMode.run(file.mode_id);
        return { ok: true };
      }
    );

    // --- Каталог Modrinth ---

    secured.get<{
      Querystring: {
        q?: string;
        type?: modrinth.ProjectType;
        minecraft?: string;
        loader?: string;
      };
    }>("/modrinth/search", async (request, reply) => {
      const { q = "", type = "mod", minecraft = "", loader = "" } = request.query;
      try {
        return await modrinth.search(q, type, minecraft, loader);
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    });

    secured.get<{
      Querystring: {
        projectId?: string;
        type?: modrinth.ProjectType;
        minecraft?: string;
        loader?: string;
      };
    }>("/modrinth/versions", async (request, reply) => {
      const { projectId, type = "mod", minecraft = "", loader = "" } = request.query;
      if (!projectId) return reply.code(400).send({ error: "Нужен projectId" });
      try {
        return await modrinth.versions(projectId, type, minecraft, loader);
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    });

    /** Предпросмотр итогового манифеста — включая скрытые сборки. */
    // --- Магазин и монеты ---

    /** Витрина целиком, включая скрытые позиции. */
    secured.get("/shop", async (request) => {
      const origin = originOf(request);
      return queries.allShopItems.all().map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        price: item.price,
        model: item.model,
        rarity: item.rarity,
        visible: Boolean(item.visible),
        sortOrder: item.sort_order,
        url: skinUrl(item.sha1, origin),
      }));
    });

    /** Новая позиция: картинка приходит файлом, остальное — полями формы. */
    secured.post("/shop", async (request, reply) => {
      let data: Buffer | null = null;
      const fields: Record<string, string> = {};

      for await (const part of request.parts()) {
        if (part.type === "file") data = await part.toBuffer();
        else fields[part.fieldname] = String(part.value);
      }
      if (!data) return reply.code(400).send({ error: "не приложен файл" });

      const kind = fields.kind === "cape" ? "cape" : "skin";
      const shape = inspectTexture(data, kind);
      if (typeof shape === "string") return reply.code(400).send({ error: shape });

      const name = (fields.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "нужно название" });

      const price = Math.max(0, Math.round(Number(fields.price ?? 0)));
      const sha1 = await putSkin(data);

      queries.addShopItem.run({
        kind,
        name,
        price,
        sha1,
        model: fields.model === "slim" ? "slim" : "classic",
        rarity: RARITIES.includes(fields.rarity as Rarity) ? (fields.rarity as Rarity) : "green",
        visible: fields.visible === "false" ? 0 : 1,
        sort_order: Math.round(Number(fields.sortOrder ?? 0)),
      });

      return { ok: true };
    });

    secured.put<{
      Params: { id: string };
      Body: {
        name?: string;
        price?: number;
        rarity?: Rarity;
        visible?: boolean;
        sortOrder?: number;
      };
    }>(
      "/shop/:id",
      async (request, reply) => {
        const item = queries.shopItem.get(Number(request.params.id));
        if (!item) return reply.code(404).send({ error: "вещь не найдена" });

        const rarity = request.body.rarity;
        queries.updateShopItem.run({
          id: item.id,
          name: (request.body.name ?? item.name).trim(),
          price: Math.max(0, Math.round(request.body.price ?? item.price)),
          rarity: RARITIES.includes(rarity as Rarity) ? rarity : item.rarity,
          visible: request.body.visible === undefined ? item.visible : request.body.visible ? 1 : 0,
          sort_order: Math.round(request.body.sortOrder ?? item.sort_order),
        });
        return { ok: true };
      }
    );

    /** Убрать с витрины. У тех, кто купил, вещь остаётся в библиотеке. */
    secured.delete<{ Params: { id: string } }>("/shop/:id", async (request, reply) => {
      const item = queries.shopItem.get(Number(request.params.id));
      if (!item) return reply.code(404).send({ error: "вещь не найдена" });

      queries.dropShopItem.run(item.id);
      return { ok: true };
    });

    /** Игроки: ники, кошельки, кого забанили. */
    secured.get("/accounts", async () =>
      queries.allAccounts.all().map((account) => ({
        id: account.id,
        username: account.username,
        telegramName: account.telegram_name,
        coins: account.coins ?? 0,
        banned: Boolean(account.banned),
        createdAt: account.created_at,
      }))
    );

    /** Начисление и списание монет — руками или из будущих достижений. */
    secured.post<{ Params: { id: string }; Body: { delta?: number; reason?: string } }>(
      "/accounts/:id/coins",
      async (request, reply) => {
        const account = queries.accountById.get(request.params.id);
        if (!account) return reply.code(404).send({ error: "аккаунт не найден" });

        const delta = Math.round(Number(request.body?.delta ?? 0));
        if (!delta) return reply.code(400).send({ error: "нужно ненулевое изменение" });

        const reason = (request.body?.reason ?? "вручную из админки").trim();
        if ((account.coins ?? 0) + delta < 0) {
          return reply.code(400).send({ error: "у игрока столько нет" });
        }

        grant(account.id, delta, reason);
        const fresh = queries.accountById.get(account.id);
        return { coins: fresh?.coins ?? 0 };
      }
    );

    secured.get<{ Params: { id: string } }>("/accounts/:id/ledger", async (request) =>
      queries.ledgerOf.all(request.params.id)
    );

    secured.get("/manifest/preview", async (request) =>
      buildManifest(originOf(request), true)
    );
  });
}
