import { createPublicKey, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.js";
import { queries } from "./db.js";
import { skinUrl } from "./skins.js";
import type { AccountRow } from "./types.js";

/**
 * Своя авторизация для самой игры — протокол Yggdrasil, тот же, что у Mojang.
 *
 * Клиент и игровой сервер запускаются с authlib-injector, который заворачивает
 * их обращения к Mojang на нас. Отсюда игра узнаёт UUID, ник и скин игрока, а
 * сервер — что игрок действительно тот, за кого себя выдаёт.
 *
 * Текстуры подписываются нашим ключом: без подписи клиент их не примет.
 */

const KEY_FILE = resolve(config.dataDir, "yggdrasil-private.pem");

function loadOrCreateKey(): { privateKey: string; publicKey: string } {
  if (existsSync(KEY_FILE)) {
    const privateKey = readFileSync(KEY_FILE, "utf8");
    const publicKey = createPublicPem(privateKey);
    return { privateKey, publicKey };
  }

  // Первый запуск: заводим пару и кладём рядом с базой. Ключ менять нельзя —
  // вместе с ним протухнут все выданные подписи текстур.
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  writeFileSync(KEY_FILE, pair.privateKey, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function createPublicPem(privateKey: string): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

let keys: { privateKey: string; publicKey: string } | null = null;

function key() {
  if (!keys) keys = loadOrCreateKey();
  return keys;
}

export function publicKeyPem(): string {
  return key().publicKey;
}

/** Mojang подписывает свойства профиля именно RSA-SHA1 — повторяем. */
function sign(value: string): string {
  const signer = createSign("RSA-SHA1");
  signer.update(value);
  return signer.sign(key().privateKey, "base64");
}

export interface GameProfile {
  id: string;
  name: string;
  properties?: Array<{ name: string; value: string; signature?: string }>;
}

/** Профиль без текстур — таким он ходит в ответах авторизации. */
export function plainProfile(account: AccountRow): GameProfile {
  return { id: account.id, name: account.username ?? "" };
}

/**
 * Профиль с текстурами. Подпись нужна, только когда профиль отдаётся игровому
 * серверу или клиенту: у остальных ответов её просят убрать.
 */
export function texturedProfile(
  account: AccountRow,
  origin: string,
  signed: boolean
): GameProfile {
  const textures: Record<string, { url: string; metadata?: { model: string } }> = {};

  if (account.skin_sha1) {
    textures.SKIN = {
      url: skinUrl(account.skin_sha1, origin),
      // Тонкие руки помечаются метаданными; классическая модель — без них.
      ...(account.skin_model === "slim" ? { metadata: { model: "slim" } } : {}),
    };
  }

  if (account.cape_sha1) {
    textures.CAPE = { url: skinUrl(account.cape_sha1, origin) };
  }

  const value = Buffer.from(
    JSON.stringify({
      timestamp: Date.now(),
      profileId: account.id,
      profileName: account.username ?? "",
      textures,
    })
  ).toString("base64");

  return {
    id: account.id,
    name: account.username ?? "",
    properties: [{ name: "textures", value, ...(signed ? { signature: sign(value) } : {}) }],
  };
}

/** Токен доступа к игре: живёт дольше сессии лаунчера, но не вечно. */
const TOKEN_TTL_MS = 14 * 86400 * 1000;

function stamp(afterMs: number): string {
  return new Date(Date.now() + afterMs).toISOString().replace("T", " ").slice(0, 19);
}

export function issueToken(accountId: string, clientToken?: string) {
  const accessToken = randomUUID().replace(/-/g, "");
  const client = clientToken || randomUUID().replace(/-/g, "");
  queries.createGameToken.run(accessToken, client, accountId, stamp(TOKEN_TTL_MS));
  return { accessToken, clientToken: client };
}

export function accountByToken(accessToken: string, clientToken?: string): AccountRow | null {
  const row = queries.gameToken.get(accessToken);
  if (!row) return null;
  if (clientToken && row.client_token !== clientToken) return null;

  if (new Date(row.expires_at.replace(" ", "T") + "Z").getTime() < Date.now()) {
    queries.dropGameToken.run(accessToken);
    return null;
  }
  return queries.accountById.get(row.account_id) ?? null;
}
