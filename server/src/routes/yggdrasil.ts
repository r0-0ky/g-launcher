import type { FastifyInstance, FastifyReply } from "fastify";

import { queries } from "../db.js";
import {
  accountByToken,
  issueToken,
  plainProfile,
  publicKeyPem,
  texturedProfile,
} from "../gameauth.js";
import { accountFromRequest } from "./account.js";
import { originOf } from "../util.js";
import { VANILLA_DOMAIN } from "../vanilla.js";

/**
 * Протокол Yggdrasil — тот же, по которому игра ходит к Mojang. Клиент и
 * игровой сервер запускаются с authlib-injector, он подменяет адреса на наши.
 *
 * Пароля у нас нет: игрок входит через Telegram в лаунчере, а сюда приносит
 * полученную сессию. Для сторонних лаунчеров это выглядит как обычный вход,
 * где вместо пароля вставляют токен.
 */

/** Ошибки протокола выглядят одинаково, иначе игра их не понимает. */
function fail(reply: FastifyReply, code: number, message: string, kind = "ForbiddenOperationException") {
  return reply.code(code).send({ error: kind, errorMessage: message });
}

interface AuthBody {
  username?: string;
  password?: string;
  clientToken?: string;
  accessToken?: string;
  requestUser?: boolean;
}

export async function yggdrasilRoutes(app: FastifyInstance): Promise<void> {
  /** Корень: отсюда authlib-injector узнаёт наш публичный ключ. */
  app.get("/", async (request) => {
    const origin = originOf(request);
    const host = new URL(origin).host;

    return {
      meta: {
        serverName: "G Land",
        implementationName: "g-launcher",
        implementationVersion: "1.0",
        "feature.non_email_login": true,
      },
      // Откуда игре разрешено брать скины: свой домен и, если настроен, бакет.
      skinDomains: [host, `.${host}`, ".r2.dev", ".onlyg.land", VANILLA_DOMAIN],
      signaturePublickey: publicKeyPem(),
    };
  });

  // --- Авторизация ---

  /** Вместо пароля — сессия лаунчера, полученная после входа через Telegram. */
  app.post<{ Body: AuthBody }>("/authserver/authenticate", async (request, reply) => {
    const password = (request.body?.password ?? "").trim();
    if (!password) return fail(reply, 403, "Вместо пароля нужен токен из лаунчера.");

    const session = queries.sessionByToken.get(password);
    const account = session ? queries.accountById.get(session.account_id) : null;
    if (!account) return fail(reply, 403, "Токен не подходит или устарел.");
    if (account.banned) return fail(reply, 403, "Аккаунт заблокирован.");
    if (!account.username) return fail(reply, 403, "Сначала выберите ник в лаунчере.");

    const { accessToken, clientToken } = issueToken(account.id, request.body?.clientToken);
    const profile = plainProfile(account);

    return {
      accessToken,
      clientToken,
      availableProfiles: [profile],
      selectedProfile: profile,
      ...(request.body?.requestUser ? { user: { id: account.id, properties: [] } } : {}),
    };
  });

  /** Продление: игра меняет старый токен на новый, не спрашивая игрока. */
  app.post<{ Body: AuthBody }>("/authserver/refresh", async (request, reply) => {
    const { accessToken = "", clientToken } = request.body ?? {};
    const account = accountByToken(accessToken, clientToken);
    if (!account) return fail(reply, 403, "Токен не подходит или устарел.");

    queries.dropGameToken.run(accessToken);
    const issued = issueToken(account.id, clientToken);
    const profile = plainProfile(account);

    return {
      accessToken: issued.accessToken,
      clientToken: issued.clientToken,
      selectedProfile: profile,
      ...(request.body?.requestUser ? { user: { id: account.id, properties: [] } } : {}),
    };
  });

  app.post<{ Body: AuthBody }>("/authserver/validate", async (request, reply) => {
    const account = accountByToken(request.body?.accessToken ?? "", request.body?.clientToken);
    if (!account) return fail(reply, 403, "Токен не подходит или устарел.");
    return reply.code(204).send();
  });

  app.post<{ Body: AuthBody }>("/authserver/invalidate", async (request, reply) => {
    queries.dropGameToken.run(request.body?.accessToken ?? "");
    return reply.code(204).send();
  });

  /** Выход со всех устройств: гасим все токены игрока. */
  app.post<{ Body: AuthBody }>("/authserver/signout", async (request, reply) => {
    const password = (request.body?.password ?? "").trim();
    const session = password ? queries.sessionByToken.get(password) : null;
    if (!session) return fail(reply, 403, "Токен не подходит или устарел.");

    queries.dropGameTokensOf.run(session.account_id);
    return reply.code(204).send();
  });

  // --- Сессии: рукопожатие клиента и игрового сервера ---

  /** Клиент сообщает, что заходит на сервер с таким-то serverId. */
  app.post<{ Body: { accessToken?: string; selectedProfile?: string; serverId?: string } }>(
    "/sessionserver/session/minecraft/join",
    async (request, reply) => {
      const { accessToken = "", selectedProfile = "", serverId = "" } = request.body ?? {};
      const account = accountByToken(accessToken);

      if (!account || account.id !== selectedProfile) {
        return fail(reply, 403, "Токен не подходит или устарел.");
      }
      if (!serverId) return fail(reply, 400, "Не передан serverId.", "IllegalArgumentException");

      queries.rememberJoin.run(serverId, account.id);
      return reply.code(204).send();
    }
  );

  /** Игровой сервер спрашивает: этот игрок только что заходил? */
  app.get<{ Querystring: { username?: string; serverId?: string } }>(
    "/sessionserver/session/minecraft/hasJoined",
    async (request, reply) => {
      const { username = "", serverId = "" } = request.query;
      const account = queries.accountByName.get(username);
      if (!account || !serverId) return reply.code(204).send();

      const join = queries.findJoin.get(serverId, account.id);
      if (!join) return reply.code(204).send();

      // Рукопожатие живёт полминуты: этого хватает на вход и не хватает на то,
      // чтобы записью воспользовался кто-то ещё.
      const age = Date.now() - new Date(join.created_at.replace(" ", "T") + "Z").getTime();
      if (age > 60_000) return reply.code(204).send();

      return texturedProfile(account, originOf(request), true);
    }
  );

  /** Профиль по UUID — так игра узнаёт скин чужого игрока. */
  app.get<{ Params: { uuid: string }; Querystring: { unsigned?: string } }>(
    "/sessionserver/session/minecraft/profile/:uuid",
    async (request, reply) => {
      const account = queries.accountById.get(request.params.uuid.replace(/-/g, ""));
      if (!account?.username) return reply.code(204).send();

      const signed = request.query.unsigned === "false";
      return texturedProfile(account, originOf(request), signed);
    }
  );

  // --- Справочник ---

  /** Ники в UUID пачкой: этим пользуются серверные плагины. */
  app.post<{ Body: string[] }>("/api/profiles/minecraft", async (request) => {
    const names = Array.isArray(request.body) ? request.body.slice(0, 100) : [];
    return names
      .map((name) => queries.accountByName.get(String(name)))
      .filter((account) => account?.username)
      .map((account) => plainProfile(account!));
  });

  /** Для лаунчера: выдать токен игры, уже имея сессию. */
  app.post("/token", async (request, reply) => {
    const account = accountFromRequest(request);
    if (!account) return fail(reply, 401, "Нужен вход.");
    if (account.banned) return fail(reply, 403, "Аккаунт заблокирован.");
    if (!account.username) return fail(reply, 403, "Сначала выберите ник.");

    const { accessToken, clientToken } = issueToken(account.id);
    return { accessToken, clientToken, profile: plainProfile(account) };
  });
}

// Протухшие токены и рукопожатия подчищаем, чтобы таблицы не пухли.
setInterval(() => {
  queries.dropStaleGameTokens.run();
  queries.dropStaleJoins.run();
}, 600_000).unref();
