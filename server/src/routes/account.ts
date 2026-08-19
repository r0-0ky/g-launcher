import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config, telegramReady } from "../config.js";
import { queries } from "../db.js";
import { dropSkin, inspectTexture, putSkin, skinUrl } from "../skins.js";
import { originOf } from "../util.js";
import { loginUrl, sendMessage } from "../telegram.js";
import type { AccountRow } from "../types.js";

/**
 * Вход игрока через Telegram.
 *
 * Лаунчер просит ссылку, открывает её в браузере, игрок жмёт «Start» — бот
 * получает от Telegram обновление с тем же одноразовым кодом и связывает его
 * со своим аккаунтом. Лаунчер тем временем опрашивает статус и получает
 * сессию. Пароли не заводим вовсе: подтверждает личность Telegram.
 */

/** Сколько ждём нажатия кнопки в боте. */
const LOGIN_TTL_MS = 10 * 60 * 1000;

const NICKNAME = /^[A-Za-z0-9_]{3,16}$/;

/** Простой ограничитель: не больше горстки попыток входа с адреса в минуту. */
const attempts = new Map<string, { count: number; until: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const seen = attempts.get(ip);
  if (!seen || seen.until < now) {
    attempts.set(ip, { count: 1, until: now + 60_000 });
    return false;
  }
  seen.count += 1;
  return seen.count > 10;
}

function iso(afterMs: number): string {
  return new Date(Date.now() + afterMs).toISOString().replace("T", " ").slice(0, 19);
}

/** Как аккаунт выглядит снаружи: ни telegram_id, ни служебных полей. */
function profileOf(account: AccountRow) {
  return {
    id: account.id,
    username: account.username,
    skinModel: account.skin_model,
    hasSkin: Boolean(account.skin_sha1),
    hasCape: Boolean(account.cape_sha1),
    banned: Boolean(account.banned),
  };
}

/** Надевает текстуру: активные хранятся прямо в аккаунте. */
function wear(
  account: AccountRow,
  kind: "skin" | "cape",
  sha1: string | null,
  model: "classic" | "slim"
): void {
  if (kind === "skin") queries.setSkin.run(sha1, model, account.id);
  else queries.setCape.run(sha1, account.id);
}

/** Библиотека игрока: что залито и что надето сейчас. */
function libraryOf(account: AccountRow, origin: string) {
  const pack = (kind: "skin" | "cape") =>
    queries.texturesOf.all(account.id, kind).map((texture) => ({
      id: texture.id,
      kind: texture.kind,
      model: texture.model,
      url: skinUrl(texture.sha1, origin),
      active:
        kind === "skin"
          ? account.skin_sha1 === texture.sha1
          : account.cape_sha1 === texture.sha1,
    }));

  return { profile: profileOf(account), skins: pack("skin"), capes: pack("cape") };
}

/** Достаёт аккаунт по сессионному токену. Протухшие сессии удаляет. */
export function accountFromRequest(request: FastifyRequest): AccountRow | null {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;

  const session = queries.sessionByToken.get(header.slice(7));
  if (!session) return null;
  if (new Date(session.expires_at.replace(" ", "T") + "Z").getTime() < Date.now()) {
    queries.dropSession.run(session.token);
    return null;
  }
  return queries.accountById.get(session.account_id) ?? null;
}

async function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AccountRow | null> {
  const account = accountFromRequest(request);
  if (!account) {
    await reply.code(401).send({ error: "нужен вход" });
    return null;
  }
  if (account.banned) {
    await reply.code(403).send({ error: "аккаунт заблокирован" });
    return null;
  }
  return account;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /** Начало входа: лаунчер получает ссылку на бота и код для опроса. */
  app.post("/auth/start", async (request, reply) => {
    if (!telegramReady) {
      return reply.code(503).send({ error: "вход через Telegram не настроен" });
    }
    if (tooManyAttempts(request.ip)) {
      return reply.code(429).send({ error: "слишком часто, подождите минуту" });
    }

    const token = randomBytes(24).toString("hex");
    queries.createLogin.run(token, iso(LOGIN_TTL_MS));

    return { token, url: loginUrl(token), expiresIn: Math.round(LOGIN_TTL_MS / 1000) };
  });

  /** Лаунчер опрашивает: нажали кнопку в боте или ещё нет. */
  app.get<{ Querystring: { token?: string } }>("/auth/status", async (request, reply) => {
    const token = request.query.token ?? "";
    const attempt = queries.loginByToken.get(token);
    if (!attempt) return reply.code(404).send({ error: "код не найден или истёк" });

    if (new Date(attempt.expires_at.replace(" ", "T") + "Z").getTime() < Date.now()) {
      queries.dropLogin.run(token);
      return reply.code(410).send({ error: "код истёк" });
    }

    if (!attempt.account_id) return { status: "pending" };

    const account = queries.accountById.get(attempt.account_id);
    if (!account) return reply.code(404).send({ error: "аккаунт не найден" });
    if (account.banned) return reply.code(403).send({ error: "аккаунт заблокирован" });

    // Код одноразовый: обменяли на сессию — и удалили.
    queries.dropLogin.run(token);
    const session = randomBytes(32).toString("hex");
    queries.createSession.run(session, account.id, iso(config.accountSessionTtlMs));

    return { status: "ready", session, profile: profileOf(account) };
  });

  /** Сюда Telegram присылает сообщения боту. */
  app.post<{ Body: { message?: { text?: string; chat: { id: number }; from?: { id: number; username?: string } } } }>(
    "/telegram/webhook",
    async (request, reply) => {
      const secret = request.headers["x-telegram-bot-api-secret-token"];
      if (!config.telegramWebhookSecret || secret !== config.telegramWebhookSecret) {
        return reply.code(401).send({ error: "чужой запрос" });
      }

      const message = request.body?.message;
      const from = message?.from;
      const text = (message?.text ?? "").trim();
      if (!message || !from) return { ok: true };

      const match = /^\/start\s+([a-f0-9]{16,64})$/.exec(text);
      if (!match) {
        await sendMessage(
          message.chat.id,
          "Открой лаунчер, нажми «Войти через Telegram» и перейди по ссылке оттуда."
        );
        return { ok: true };
      }

      const token = match[1];
      const attempt = queries.loginByToken.get(token);
      if (!attempt) {
        await sendMessage(message.chat.id, "Ссылка устарела. Запроси вход в лаунчере заново.");
        return { ok: true };
      }

      // Аккаунт заводится молча при первом входе.
      let account = queries.accountByTelegram.get(from.id);
      if (!account) {
        const id = randomUUID().replace(/-/g, "");
        queries.insertAccount.run({
          id,
          telegram_id: from.id,
          telegram_name: from.username ?? null,
        });
        account = queries.accountById.get(id);
      } else if (from.username && from.username !== account.telegram_name) {
        queries.touchTelegramName.run(from.username, account.id);
      }

      if (!account) {
        await sendMessage(message.chat.id, "Не получилось завести аккаунт, попробуй ещё раз.");
        return { ok: true };
      }
      if (account.banned) {
        await sendMessage(message.chat.id, "Аккаунт заблокирован.");
        return { ok: true };
      }

      queries.confirmLogin.run(account.id, token);
      await sendMessage(
        message.chat.id,
        account.username
          ? `Готово, ${account.username}. Возвращайся в лаунчер.`
          : "Готово! Возвращайся в лаунчер и выбери ник."
      );
      return { ok: true };
    }
  );

  /** Кто я. */
  app.get("/me", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    return profileOf(account);
  });

  /** Смена ника: игрок меняет сам, UUID при этом остаётся прежним. */
  app.post<{ Body: { username?: string } }>("/me/nickname", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;

    const username = (request.body?.username ?? "").trim();
    if (!NICKNAME.test(username)) {
      return reply
        .code(400)
        .send({ error: "ник: 3–16 символов, латиница, цифры и подчёркивание" });
    }

    const taken = queries.accountByName.get(username);
    if (taken && taken.id !== account.id) {
      return reply.code(409).send({ error: "ник уже занят" });
    }

    queries.setUsername.run(username, account.id);
    return profileOf(queries.accountById.get(account.id) as AccountRow);
  });

  /** Что игрок уже залил: из этого он и выбирает. */
  app.get("/me/textures", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    return libraryOf(account, originOf(request));
  });

  /**
   * Загрузка текстуры. Она попадает в библиотеку и сразу становится активной —
   * заливают обычно затем, чтобы надеть.
   */
  app.post<{ Querystring: { kind?: string; model?: string } }>(
    "/me/textures",
    async (request, reply) => {
      const account = await requireAccount(request, reply);
      if (!account) return;

      const kind = request.query.kind === "cape" ? "cape" : "skin";
      const model = request.query.model === "slim" ? "slim" : "classic";

      let data: Buffer | null = null;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          data = await part.toBuffer();
          break;
        }
      }
      if (!data) return reply.code(400).send({ error: "не приложен файл" });

      const shape = inspectTexture(data, kind);
      if (typeof shape === "string") return reply.code(400).send({ error: shape });

      const sha1 = await putSkin(data);
      queries.addTexture.run({ account_id: account.id, kind, sha1, model });
      wear(account, kind, sha1, model);

      const fresh = queries.accountById.get(account.id) as AccountRow;
      return libraryOf(fresh, originOf(request));
    }
  );

  /** Надеть одну из уже залитых. */
  app.post<{ Params: { id: string } }>("/me/textures/:id/select", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;

    const texture = queries.textureById.get(Number(request.params.id));
    if (!texture || texture.account_id !== account.id) {
      return reply.code(404).send({ error: "текстура не найдена" });
    }

    wear(account, texture.kind, texture.sha1, texture.model);
    const fresh = queries.accountById.get(account.id) as AccountRow;
    return libraryOf(fresh, originOf(request));
  });

  /**
   * Тонкие руки или обычные. Меняет модель у надетого скина, а если ничего не
   * надето — запоминает выбор для следующей загрузки.
   */
  app.post<{ Querystring: { model?: string } }>("/me/textures/model", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;

    const model = request.query.model === "slim" ? "slim" : "classic";
    if (account.skin_sha1) {
      queries.setTextureModel.run(model, account.id, account.skin_sha1);
    }
    queries.setSkin.run(account.skin_sha1, model, account.id);

    const fresh = queries.accountById.get(account.id) as AccountRow;
    return libraryOf(fresh, originOf(request));
  });

  /** Снять текущую, ничего не удаляя из библиотеки. */
  app.post<{ Querystring: { kind?: string } }>("/me/textures/clear", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;

    const kind = request.query.kind === "cape" ? "cape" : "skin";
    wear(account, kind, null, account.skin_model);

    const fresh = queries.accountById.get(account.id) as AccountRow;
    return libraryOf(fresh, originOf(request));
  });

  /** Убрать из библиотеки насовсем. */
  app.delete<{ Params: { id: string } }>("/me/textures/:id", async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;

    const texture = queries.textureById.get(Number(request.params.id));
    if (!texture || texture.account_id !== account.id) {
      return reply.code(404).send({ error: "текстура не найдена" });
    }

    queries.dropTexture.run(texture.id);
    if (texture.kind === "skin" && account.skin_sha1 === texture.sha1) {
      queries.setSkin.run(null, account.skin_model, account.id);
    }
    if (texture.kind === "cape" && account.cape_sha1 === texture.sha1) {
      queries.setCape.run(null, account.id);
    }

    // Файл убираем, только если на него больше никто не ссылается: тот же
    // скин мог залить кто-то ещё, а хранится он один раз.
    const inLibrary = queries.countTextureUsers.get(texture.sha1);
    const asSkin = queries.countSkinUsers.get(texture.sha1);
    const asCape = queries.countCapeUsers.get(texture.sha1);
    if (!inLibrary?.count && !asSkin?.count && !asCape?.count) {
      await dropSkin(texture.sha1);
    }

    const fresh = queries.accountById.get(account.id) as AccountRow;
    return libraryOf(fresh, originOf(request));
  });

  app.post("/me/logout", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) queries.dropSession.run(header.slice(7));
    return reply.send({ ok: true });
  });
}

// Раз в час выметаем протухшие коды и сессии, чтобы таблицы не пухли.
setInterval(() => {
  queries.dropStaleLogins.run();
  queries.dropStaleSessions.run();
}, 3600_000).unref();
