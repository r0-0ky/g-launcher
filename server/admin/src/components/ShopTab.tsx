import { useEffect, useState } from "react";
import type { PlayerAccount, Rarity, ShopItem } from "../api";
import { api, errorText } from "../api";

/**
 * Магазин: витрина косметики и кошельки игроков.
 *
 * Картинка вещи проверяется на сервере, поэтому здесь только форма: файл,
 * название, цена и качество. Купленное у игроков остаётся при них, даже если
 * позицию потом убрать с витрины.
 */

const RARITY_NAMES: Record<Rarity, string> = {
  green: "Обычное",
  blue: "Редкое",
  purple: "Эпическое",
  legendary: "Легендарное",
};

const RARITIES = Object.keys(RARITY_NAMES) as Rarity[];

interface Props {
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}

export function ShopTab({ onError, onNotice }: Props) {
  const [items, setItems] = useState<ShopItem[]>([]);
  const [defaults, setDefaults] = useState<{
    skin: { url: string; model: string } | null;
    cape: { url: string } | null;
  }>({ skin: null, cape: null });
  const [players, setPlayers] = useState<PlayerAccount[]>([]);
  const [busy, setBusy] = useState(false);

  // Черновик новой позиции.
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState(100);
  const [kind, setKind] = useState<"skin" | "cape">("skin");
  const [model, setModel] = useState<"classic" | "slim">("classic");
  const [rarity, setRarity] = useState<Rarity>("green");

  async function reload() {
    try {
      const [shop, accounts, presets] = await Promise.all([
        api.shop(),
        api.players(),
        api.defaults(),
      ]);
      setItems(shop);
      setPlayers(accounts);
      setDefaults(presets);
    } catch (err) {
      onError(errorText(err));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      form.append("name", name.trim());
      form.append("price", String(price));
      form.append("model", model);
      form.append("rarity", rarity);

      await api.addShopItem(form);
      setFile(null);
      setName("");
      onNotice("Вещь на витрине");
      await reload();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function patch(item: ShopItem, change: Partial<ShopItem>) {
    onError(null);
    try {
      await api.saveShopItem(item.id, {
        name: change.name ?? item.name,
        price: change.price ?? item.price,
        rarity: change.rarity ?? item.rarity,
        visible: change.visible ?? item.visible,
        sortOrder: change.sortOrder ?? item.sortOrder,
      });
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function remove(item: ShopItem) {
    if (!confirm(`Убрать «${item.name}» с витрины? У тех, кто купил, вещь останется.`)) return;
    onError(null);
    try {
      await api.deleteShopItem(item.id);
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function grant(player: PlayerAccount) {
    const raw = prompt(`Сколько G-коинов начислить ${player.username ?? "игроку"}?`, "100");
    if (raw === null) return;

    const delta = Math.round(Number(raw));
    if (!delta) return;

    const reason = prompt("За что?", "достижение") ?? "вручную из админки";
    onError(null);
    try {
      await api.grantCoins(player.id, delta, reason);
      onNotice("Кошелёк обновлён");
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  /** Скин или плащ, который получают новички при регистрации. */
  async function setDefaultTexture(kind: "skin" | "cape", picked: File | null) {
    if (!picked) return;
    onError(null);
    try {
      const form = new FormData();
      form.append("file", picked);
      await api.setDefault(form, kind, model);
      onNotice(kind === "skin" ? "Скин новичкам задан" : "Плащ новичкам задан");
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function clearDefault(kind: "skin" | "cape") {
    onError(null);
    try {
      await api.clearDefault(kind);
      await reload();
    } catch (err) {
      onError(errorText(err));
    }
  }

  return (
    <div className="shop">
      <section className="card">
        <h2>Новичкам при регистрации</h2>
        <div className="shop-grid">
          <div className="shop-item">
            <div
              className="shop-face"
              style={{ backgroundImage: defaults.skin ? `url(${defaults.skin.url})` : undefined }}
            />
            <div className="muted small">
              {defaults.skin
                ? `Скин · ${defaults.skin.model === "slim" ? "тонкие руки" : "обычные руки"}`
                : "Скин не задан — новички будут как Стив"}
            </div>
            <input
              type="file"
              accept="image/png"
              onChange={(event) => setDefaultTexture("skin", event.target.files?.[0] ?? null)}
            />
            {defaults.skin && (
              <button className="link danger" onClick={() => clearDefault("skin")}>
                Убрать
              </button>
            )}
          </div>

          <div className="shop-item">
            <div
              className="shop-cape"
              style={{ backgroundImage: defaults.cape ? `url(${defaults.cape.url})` : undefined }}
            />
            <div className="muted small">
              {defaults.cape ? "Плащ" : "Плащ не задан — по желанию"}
            </div>
            <input
              type="file"
              accept="image/png"
              onChange={(event) => setDefaultTexture("cape", event.target.files?.[0] ?? null)}
            />
            {defaults.cape && (
              <button className="link danger" onClick={() => clearDefault("cape")}>
                Убрать
              </button>
            )}
          </div>
        </div>
        <small className="muted">
          Выдаётся только новым аккаунтам: у тех, кто уже входил, свой выбор.
          Модель рук берётся из поля ниже.
        </small>
      </section>

      <section className="card">
        <h2>Новая вещь</h2>
        <div className="grid2">
          <label className="field">
            <span>Картинка</span>
            <input
              type="file"
              accept="image/png"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <small>
              Скин — 64×64 или 64×32, плащ вдвое шире, чем выше. Не больше 200 КБ.
            </small>
          </label>

          <label className="field">
            <span>Название</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="field">
            <span>Цена, G-коинов</span>
            <input
              type="number"
              min={0}
              value={price}
              onChange={(event) => setPrice(Number(event.target.value))}
            />
          </label>

          <label className="field">
            <span>Что это</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as "skin" | "cape")}>
              <option value="skin">Скин</option>
              <option value="cape">Плащ</option>
            </select>
          </label>

          {kind === "skin" && (
            <label className="field">
              <span>Модель</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value as "classic" | "slim")}
              >
                <option value="classic">Обычные руки</option>
                <option value="slim">Тонкие руки</option>
              </select>
            </label>
          )}

          <label className="field">
            <span>Качество</span>
            <select value={rarity} onChange={(event) => setRarity(event.target.value as Rarity)}>
              {RARITIES.map((value) => (
                <option key={value} value={value}>
                  {RARITY_NAMES[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button className="primary" onClick={add} disabled={busy || !file || !name.trim()}>
          {busy ? "Выкладываем…" : "На витрину"}
        </button>
      </section>

      <section className="card">
        <h2>Витрина · {items.length}</h2>
        {items.length === 0 && <div className="muted small">Пока пусто</div>}

        <div className="shop-grid">
          {items.map((item) => (
            <div key={item.id} className={`shop-item rarity-${item.rarity}`}>
              <div
                className={item.kind === "cape" ? "shop-cape" : "shop-face"}
                style={{ backgroundImage: `url(${item.url})` }}
              />
              <input
                className="shop-name"
                value={item.name}
                onChange={(event) => setItems((prev) =>
                  prev.map((row) => (row.id === item.id ? { ...row, name: event.target.value } : row))
                )}
                onBlur={(event) => patch(item, { name: event.target.value })}
              />
              <div className="shop-row">
                <input
                  className="shop-price"
                  type="number"
                  min={0}
                  value={item.price}
                  onChange={(event) => setItems((prev) =>
                    prev.map((row) =>
                      row.id === item.id ? { ...row, price: Number(event.target.value) } : row
                    )
                  )}
                  onBlur={(event) => patch(item, { price: Number(event.target.value) })}
                />
                <select
                  value={item.rarity}
                  onChange={(event) => patch(item, { rarity: event.target.value as Rarity })}
                >
                  {RARITIES.map((value) => (
                    <option key={value} value={value}>
                      {RARITY_NAMES[value]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="shop-row">
                <button
                  className={item.visible ? "toggle on" : "toggle"}
                  onClick={() => patch(item, { visible: !item.visible })}
                >
                  {item.visible ? "● На витрине" : "○ Скрыта"}
                </button>
                <button className="link danger" onClick={() => remove(item)}>
                  Убрать
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Игроки · {players.length}</h2>
        {players.length === 0 && <div className="muted small">Ещё никто не входил</div>}

        <table className="players">
          <tbody>
            {players.map((player) => (
              <tr key={player.id}>
                <td>{player.username ?? <span className="muted">без ника</span>}</td>
                <td className="muted small">
                  {player.telegramName ? `@${player.telegramName}` : "—"}
                </td>
                <td>{player.coins} G</td>
                <td>
                  <button className="ghost" onClick={() => grant(player)}>
                    Начислить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
