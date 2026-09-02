import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";

/**
 * Приём карт через Т-банк.
 *
 * Схема простая: зовём `/Init`, получаем ссылку на платёжную страницу банка,
 * игрок платит в браузере, а банк потом стучится к нам уведомлением. Уведомление
 * может и не дойти — тогда лаунчер, опрашивая статус, сам спросит `/GetState`.
 *
 * И запросы, и уведомления подписаны: SHA-256 от значений корневых полей,
 * отсортированных по имени, плюс пароль терминала.
 */

/** Ответ банка на `/Init`. */
export interface InitResult {
  paymentId: string;
  paymentUrl: string;
}

/** Как банк называет исход платежа. */
export type TBankStatus = "confirmed" | "failed" | "pending";

/**
 * Булевы поля банк сериализует строчными `true`/`false`. В уведомлении
 * `Success` приходит именно булевым, и `String(true)` дало бы `"true"` — но на
 * это лучше не полагаться молча, поэтому приводим явно.
 */
function asString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Подпись запроса или уведомления.
 *
 * Считается только по корневым полям с простыми значениями: вложенные объекты
 * и массивы (`Receipt`, `DATA`) в подпись не входят, как и само поле `Token`.
 */
export function signature(params: Record<string, unknown>): string {
  const signed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "Token" || value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    signed[key] = value;
  }
  signed.Password = config.tbankPassword;

  const joined = Object.keys(signed)
    .sort()
    .map((key) => asString(signed[key]))
    .join("");
  return createHash("sha256").update(joined).digest("hex");
}

/**
 * Корневой сертификат Минцифры.
 *
 * Т-банк, как и прочие российские банки, светит сертификатом от национального
 * удостоверяющего центра, а его корня нет ни в наборе Node, ни в системном
 * хранилище: соединение обрывается с `SELF_SIGNED_CERT_IN_CHAIN`, и наружу это
 * выглядит как «банк не принял платёж».
 *
 * Поэтому корень возим с собой и добавляем к обычным — только для запросов в
 * банк, а не всему процессу: остальным адресам расширенное доверие ни к чему.
 * Нет файла — работаем на системных, ошибка будет говорить сама за себя.
 */
const trustedCa = (() => {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "russian-trusted-root-ca.pem"
  );
  try {
    return [...rootCertificates, readFileSync(path, "utf8")];
  } catch {
    return undefined;
  }
})();

/** POST с телом JSON. Своими руками, а не через fetch, ради `ca` выше. */
function post(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        ca: trustedCa,
        timeout: 30_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      }
    );

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("банк не ответил за 30 секунд")));
    request.end(body);
  });
}

async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = { ...body, Token: signature(body) };

  const response = await post(`${config.tbankApiUrl}/${method}`, JSON.stringify(payload));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Т-банк ответил ${response.status} на ${method}`);
  }

  const data = JSON.parse(response.text) as Record<string, unknown>;
  if (!data.Success) {
    throw new Error(
      `Т-банк отклонил ${method}: ${data.Message ?? ""} ${data.Details ?? ""}`.trim()
    );
  }
  return data;
}

/**
 * Создать платёж и получить ссылку на страницу оплаты.
 *
 * `orderId` должен быть уникален на терминале навсегда — мы отдаём туда наш
 * идентификатор платежа, а он случайный, не порядковый.
 */
export async function initPayment(options: {
  orderId: string;
  /** Сумма в рублях. В банк уходит в копейках. */
  priceRub: number;
  description: string;
  notificationUrl: string;
}): Promise<InitResult> {
  const body: Record<string, unknown> = {
    TerminalKey: config.tbankTerminalKey,
    Amount: Math.round(options.priceRub * 100),
    OrderId: options.orderId,
    Description: options.description,
    NotificationURL: options.notificationUrl,
  };
  if (config.tbankReturnUrl) {
    body.SuccessURL = config.tbankReturnUrl;
    body.FailURL = config.tbankReturnUrl;
  }

  const data = await call("Init", body);
  return { paymentId: String(data.PaymentId), paymentUrl: String(data.PaymentURL) };
}

/** Проверить подпись уведомления: без неё начислять монеты нельзя. */
export function verifyNotification(data: Record<string, unknown>): boolean {
  const received = String(data.Token ?? "");
  return Boolean(received) && received === signature(data);
}

/** Как банк назвал исход в уведомлении или в ответе `/GetState`. */
export function statusOf(raw: unknown): TBankStatus {
  const status = String(raw ?? "");
  if (status === "CONFIRMED") return "confirmed";
  if (["REJECTED", "REVERSED", "REFUNDED", "PARTIAL_REFUNDED", "AUTH_FAIL", "CANCELED"].includes(status)) {
    return "failed";
  }
  return "pending";
}

/**
 * Спросить банк, чем кончился платёж. Нужен, когда уведомление не дошло:
 * лаунчер опрашивает статус сам, и этот вызов закрывает дыру.
 */
export async function paymentState(paymentId: string): Promise<TBankStatus> {
  const data = await call("GetState", {
    TerminalKey: config.tbankTerminalKey,
    PaymentId: paymentId,
  });
  return statusOf(data.Status);
}
