import { db, queries } from "./db.js";
import { paymentState } from "./tbank.js";
import type { CoinPaymentRow } from "./types.js";

/**
 * Зачисление оплаченных пополнений.
 *
 * Про один и тот же платёж мы узнаём с двух сторон: банк присылает уведомление,
 * а лаунчер параллельно опрашивает статус. Поэтому начисление обязано быть
 * одноразовым — этим и занимается модуль.
 */

/**
 * Зачислить платёж. Возвращает `true`, только если монеты начислены именно
 * сейчас: повторный заход вернёт `false` и ничего не тронет.
 *
 * Одноразовость держится на `UPDATE ... WHERE status = 'pending'`: перевести
 * платёж в оплаченные может лишь один вызов, и по числу изменённых строк видно,
 * чей он был.
 */
export const settle = db.transaction((payment: CoinPaymentRow): boolean => {
  const moved = queries.markPaid.run(payment.id).changes;
  if (moved === 0) return false;

  queries.addCoins.run(payment.coins, payment.account_id);
  queries.writeLedger.run(
    payment.account_id,
    payment.coins,
    `пополнение на ${payment.price} ₽`
  );
  return true;
});

/** Отметить, что платёж не состоялся. Уже зачисленный не трогаем. */
export function reject(payment: CoinPaymentRow): void {
  queries.markFailed.run(payment.id);
}

/**
 * Свежее состояние платежа. Пока он не оплачен, спрашиваем банк напрямую —
 * уведомление могло не дойти, а игрок в это время смотрит на экран оплаты.
 *
 * Отклонённые тоже переспрашиваем: отказ карты не конец истории, на форме банка
 * можно ввести другую, и оплата придёт по тому же заказу.
 *
 * Ошибку связи с банком глушим: платёж остаётся как был, лаунчер спросит снова.
 */
export async function refresh(payment: CoinPaymentRow): Promise<CoinPaymentRow> {
  if (payment.status === "paid" || !payment.payment_id) return payment;

  try {
    const status = await paymentState(payment.payment_id);
    if (status === "confirmed") settle(payment);
    else if (status === "failed") reject(payment);
  } catch {
    // Банк недоступен — пусть платёж повисит, ответим тем, что знаем.
  }

  return queries.payment.get(payment.id) ?? payment;
}
