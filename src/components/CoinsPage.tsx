import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CoinPack } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";
import { Loader } from "./Loader";
import coin from "../assets/coin.png";

/**
 * Пополнение кошелька.
 *
 * Платить картой внутри лаунчера нельзя — форму держит банк, поэтому ссылку
 * открываем в браузере и ждём. Уведомление банка может и не дойти, так что
 * лаунчер просто опрашивает статус: сервер, если надо, спросит банк сам.
 */
interface Props {
  /** Кошелёк, уже известный лаунчеру: показываем, пока едут тарифы. */
  coins?: number | null;
  /** Кошелёк изменился — обновить его в панели слева и в магазине. */
  onPaid: () => void;
  onClose: () => void;
}

/** Как часто спрашиваем, оплачено ли. */
const POLL_MS = 3000;

export function CoinsPage({ coins, onPaid, onClose }: Props) {
  const [packs, setPacks] = useState<CoinPack[]>([]);
  const [available, setAvailable] = useState(true);
  const [balance, setBalance] = useState<number | null>(coins ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Начатая оплата: пока она есть, ждём и опрашиваем. */
  const [pending, setPending] = useState<{ id: string; pack: CoinPack } | null>(null);
  /** Только что зачисленное — показываем, пока игрок не закроет. */
  const [paid, setPaid] = useState<number | null>(null);
  const [starting, setStarting] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.glandCoinPacks();
      setPacks(data.packs);
      setAvailable(data.available);
      setBalance(data.coins);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Выход по Escape — как из карточки вещи в магазине.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, pending]);

  // Опрос идёт, только пока есть незавершённая оплата.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  useEffect(() => {
    if (!pending) return;

    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const status = await api.glandPaymentStatus(pending.id);
        if (!alive) return;

        if (status.status === "paid") {
          setPending(null);
          setPaid(status.coins);
          setBalance(status.balance);
          onPaidRef.current();
        } else if (status.status === "failed") {
          setPending(null);
          setError("Оплата не прошла. Деньги, если списались, вернёт банк.");
        }
      } catch (err) {
        // Связь моргнула — спросим на следующем круге, платёж никуда не денется.
        if (alive) console.warn("не вышло спросить статус оплаты", err);
      }
    }, POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pending]);

  async function pay(pack: CoinPack) {
    setStarting(pack.id);
    setError(null);
    try {
      const started = await api.glandBuyCoins(pack.id);
      await openUrl(started.url);
      setPending({ id: started.id, pack });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(null);
    }
  }

  /** Сколько коинов за рубль — по этому и видно, какой тариф выгоднее. */
  const perRuble = (pack: CoinPack) => (pack.price > 0 ? pack.coins / pack.price : 0);
  const best = packs.reduce((top, pack) => Math.max(top, perRuble(pack)), 0);

  return (
    <section className="coins-page">
      <header className="account-head">
        <h2>Пополнить кошелёк</h2>
        <span className="wallet" title="G-коины">
          <img src={coin} alt="" />
          {balance ?? coins ?? 0}
        </span>
      </header>

      {error && <div className="error">{error}</div>}

      {paid !== null && (
        <div className="coins-done">
          <img src={coin} alt="" />
          <div>
            <b>+{paid} G-коинов</b>
            <div className="muted small">Зачислено на кошелёк</div>
          </div>
          <Button variant="primary" onClick={() => setPaid(null)}>
            Отлично
          </Button>
        </div>
      )}

      {pending && (
        <div className="coins-waiting">
          <Loader label="Ждём оплату…" />
          <p>
            Оплата «{pending.pack.name}» открылась в браузере. Закончите там — коины
            появятся здесь сами.
          </p>
          <Button variant="secondary" onClick={() => setPending(null)}>
            Я передумал
          </Button>
        </div>
      )}

      <div className="account-main">
        {loading && <Loader label="Смотрим тарифы…" />}

        {!loading && !available && (
          <span className="muted">
            Пополнение сейчас не работает — приём карт на сервере не настроен.
          </span>
        )}

        {!loading && available && packs.length === 0 && (
          <span className="muted">Тарифов пока нет — загляните позже</span>
        )}

        {available && packs.length > 0 && (
          <div className="coin-grid">
            {packs.map((pack, index) => (
              <div
                key={pack.id}
                className={[
                  "coin-card",
                  // Тарифы приходят от дешёвых к дорогим, поэтому ступень берём
                  // прямо по месту в списке.
                  `coin-tier-${Math.min(index + 1, 4)}`,
                  perRuble(pack) === best ? "coin-card-best" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {pack.badge && <div className="coin-badge">{pack.badge}</div>}

                <img className="coin-face" src={coin} alt="" draggable={false} />
                <div className="coin-amount">{pack.coins}</div>
                <div className="coin-name">{pack.name}</div>

                <Button
                  variant="primary"
                  onClick={() => pay(pack)}
                  disabled={Boolean(pending) || starting === pack.id}
                >
                  {starting === pack.id ? "Открываем…" : `${pack.price} ₽`}
                </Button>
              </div>
            ))}
          </div>
        )}

        <small>
          Оплата картой через Т-банк, на его странице. Данные карты в лаунчер не
          попадают — он только открывает браузер и ждёт ответа.
        </small>
      </div>

      <div className="row">
        <Button variant="secondary" onClick={onClose}>
          Назад в магазин
        </Button>
      </div>
    </section>
  );
}
