import { useEffect, useState } from "react";
import type { CoinPack } from "../api";
import { api, errorText } from "../api";

/**
 * Тарифы пополнения кошелька.
 *
 * Игрок видит их на отдельной странице лаунчера и платит картой через Т-банк.
 * Здесь задаётся только «сколько коинов за сколько рублей» — всё остальное
 * происходит на стороне банка.
 */
interface Props {
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}

export function CoinsTab({ onError, onNotice }: Props) {
  const [packs, setPacks] = useState<CoinPack[]>([]);
  /** Терминал не настроен — тарифы заводить можно, но купить по ним нельзя. */
  const [paymentsReady, setPaymentsReady] = useState(true);
  const [busy, setBusy] = useState(false);

  // Черновик нового тарифа.
  const [name, setName] = useState("");
  const [coins, setCoins] = useState(600);
  const [price, setPrice] = useState(100);
  const [badge, setBadge] = useState("");

  async function reload() {
    try {
      const data = await api.coinPacks();
      setPacks(data.packs);
      setPaymentsReady(data.paymentsReady);
    } catch (err) {
      onError(errorText(err));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    setBusy(true);
    onError(null);
    try {
      await api.addCoinPack({
        name: name.trim(),
        coins,
        price,
        badge: badge.trim() || null,
        sortOrder: packs.length,
      });
      setName("");
      setBadge("");
      onNotice("Тариф добавлен");
      await reload();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Показать правку сразу, не дожидаясь ответа сервера. */
  function edit(id: number, change: Partial<CoinPack>) {
    setPacks((prev) => prev.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }

  async function patch(pack: CoinPack, change: Partial<CoinPack>) {
    onError(null);
    try {
      await api.saveCoinPack(pack.id, {
        name: change.name ?? pack.name,
        coins: change.coins ?? pack.coins,
        price: change.price ?? pack.price,
        badge: change.badge === undefined ? pack.badge : change.badge,
        visible: change.visible ?? pack.visible,
        sortOrder: change.sortOrder ?? pack.sortOrder,
      });
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function remove(pack: CoinPack) {
    if (!confirm(`Убрать тариф «${pack.name}»? Уже оплаченные пополнения останутся.`)) return;
    onError(null);
    try {
      await api.deleteCoinPack(pack.id);
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  /** Сколько монет приходится на рубль — по этому и сравнивают тарифы. */
  const perRuble = (pack: CoinPack) => (pack.price > 0 ? pack.coins / pack.price : 0);
  const best = packs.reduce((top, pack) => Math.max(top, perRuble(pack)), 0);

  return (
    <>
      {!paymentsReady && (
        <div className="notice warn">
          Приём карт не настроен: в окружении сервера нет <code>TBANK_TERMINAL_KEY</code> и
          <code>TBANK_PASSWORD</code>. Тарифы можно завести заранее, но кнопка пополнения в
          лаунчере не появится.
        </div>
      )}

      <section className="card">
        <h2>Новый тариф</h2>
        <div className="grid2">
          <label className="field">
            <span>Название</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Горсть коинов"
            />
          </label>

          <label className="field">
            <span>Плашка</span>
            <input
              value={badge}
              onChange={(event) => setBadge(event.target.value)}
              placeholder="выгодно"
            />
            <small>Необязательно. Показывается уголком на карточке тарифа.</small>
          </label>

          <label className="field">
            <span>Сколько коинов</span>
            <input
              type="number"
              min={1}
              value={coins}
              onChange={(event) => setCoins(Number(event.target.value))}
            />
          </label>

          <label className="field">
            <span>Цена, ₽</span>
            <input
              type="number"
              min={1}
              value={price}
              onChange={(event) => setPrice(Number(event.target.value))}
            />
            <small>
              Целыми рублями. Выходит {price > 0 ? Math.round((coins / price) * 10) / 10 : 0} коинов
              за рубль.
            </small>
          </label>
        </div>

        <button className="primary" disabled={busy || !name.trim() || coins < 1 || price < 1} onClick={add}>
          {busy ? "Добавляем…" : "Добавить тариф"}
        </button>
      </section>

      <section className="card">
        <h2>Тарифы</h2>
        {packs.length === 0 && <div className="muted">Тарифов пока нет</div>}

        {packs.length > 0 && (
          <table className="packs">
            <thead>
              <tr>
                <th>Название</th>
                <th>Коинов</th>
                <th>Цена, ₽</th>
                <th>За рубль</th>
                <th>Плашка</th>
                <th>Показывать</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {packs.map((pack) => (
                <tr key={pack.id}>
                  <td>
                    <input
                      value={pack.name}
                      onChange={(event) => edit(pack.id, { name: event.target.value })}
                      onBlur={(event) => patch(pack, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={pack.coins}
                      onChange={(event) => edit(pack.id, { coins: Number(event.target.value) })}
                      onBlur={(event) => patch(pack, { coins: Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={pack.price}
                      onChange={(event) => edit(pack.id, { price: Number(event.target.value) })}
                      onBlur={(event) => patch(pack, { price: Number(event.target.value) })}
                    />
                  </td>
                  {/* Самый выгодный тариф подсвечиваем: так видно, что витрина
                      выстроена как задумано, а не наоборот. */}
                  <td className={perRuble(pack) === best ? "" : "muted"}>
                    {Math.round(perRuble(pack) * 10) / 10}
                  </td>
                  <td>
                    <input
                      value={pack.badge ?? ""}
                      placeholder="—"
                      onChange={(event) => edit(pack.id, { badge: event.target.value })}
                      onBlur={(event) => patch(pack, { badge: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={pack.visible}
                      onChange={(event) => patch(pack, { visible: event.target.checked })}
                    />
                  </td>
                  <td>
                    <button className="link danger" onClick={() => remove(pack)}>
                      Убрать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <small className="muted">
          Правки сохраняются сразу. Скрытый тариф пропадает из лаунчера, но начисления по
          нему остаются в истории игрока.
        </small>
      </section>
    </>
  );
}
