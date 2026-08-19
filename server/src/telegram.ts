import { config, telegramReady } from "./config.js";

/**
 * Тонкая обёртка над Bot API. Бот нужен ровно для одного: подтвердить, что
 * человек с таким Telegram нажал кнопку входа в лаунчере.
 */

const API = "https://api.telegram.org/bot";

async function call<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API}${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram ответил на ${method}: ${data.description ?? response.status}`);
  }
  return data.result;
}

export function loginUrl(token: string): string {
  return `https://t.me/${config.telegramBotName}?start=${token}`;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!telegramReady) return;
  try {
    await call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  } catch {
    // Сообщение — вежливость, а не часть входа: молчим, но вход не роняем,
    // иначе Telegram начнёт долбить вебхук повторами.
  }
}

/**
 * Ставит вебхук на наш адрес. Telegram будет присылать секрет заголовком, по
 * нему и отличаем настоящие запросы от чужих.
 */
export async function setWebhook(url: string, secret: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secret,
    // Нас интересуют только сообщения — остальные события не нужны.
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export interface TelegramUpdate {
  message?: {
    text?: string;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
  };
}
