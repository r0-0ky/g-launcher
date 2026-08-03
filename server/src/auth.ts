import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "./config.js";

const sessions = new Map<string, number>();

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function login(password: string): string | null {
  if (!config.adminPassword) {
    throw new Error("ADMIN_PASSWORD не задан — вход в админку отключён");
  }
  if (!equalStrings(password, config.adminPassword)) return null;

  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + config.sessionTtlMs);
  return token;
}

export function logout(token: string): void {
  sessions.delete(token);
}

function isValid(token: string): boolean {
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Хук Fastify: пускает дальше только с живым токеном администратора. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!isValid(token)) {
    await reply.code(401).send({ error: "Нужен вход в админку" });
  }
}

// Раз в час подчищаем протухшие сессии, чтобы карта не росла бесконечно.
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt < now) sessions.delete(token);
  }
}, 3600_000).unref();
