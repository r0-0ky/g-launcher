import { useEffect, useState } from "react";
import type { Shop } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";
import { SkinPreview } from "./SkinPreview";
import coin from "../assets/coin.png";

/**
 * Магазин косметики. Витрину и кошелёк отдаёт сервер; купленное сразу
 * попадает в библиотеку игрока, надеть можно на странице аккаунта.
 */
interface Props {
  /** Обновить страницу аккаунта после покупки, если она открыта. */
  onBought?: () => void;
}

const RARITY_NAMES: Record<string, string> = {
  green: "Обычное",
  blue: "Редкое",
  purple: "Эпическое",
  legendary: "Легендарное",
};

export function ShopPage({ onBought }: Props) {
  const [shop, setShop] = useState<Shop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function reload() {
    try {
      setShop(await api.glandShop());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function buy(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api.glandBuy(id);
      await reload();
      onBought?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="shop-page">
      <header className="account-head">
        <h2>Магазин</h2>
        <span className="wallet" title="G-коины">
          <img src={coin} alt="" />
          {shop?.coins ?? 0}
        </span>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="account-main">
        {shop && shop.items.length === 0 && (
          <span className="muted">Витрина пока пуста — загляните позже</span>
        )}

        {!!shop?.items.length && (
          <div className="shop-grid">
            {shop.items.map((item) => (
              <div key={item.id} className={`shop-card rarity-${item.rarity}`}>
                {/* Скин показываем на модели целиком, плащ — поверх того, во
                    что игрок одет: иначе не понять, как он будет смотреться. */}
                <div
                  className="shop-card-art"
                  title={RARITY_NAMES[item.rarity] ?? item.rarity}
                >
                  <SkinPreview
                    skin={item.kind === "cape" ? (shop.wearing?.skin ?? null) : item.url}
                    cape={item.kind === "cape" ? item.url : null}
                    model={item.kind === "cape" ? (shop.wearing?.model ?? "classic") : item.model}
                    width={180}
                    height={240}
                    rotate
                    locked
                  />
                </div>

                <div className="shop-card-foot">
                  <div className="shop-card-name">{item.name}</div>
                  {item.owned ? (
                    <span className="muted small">Куплено</span>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => buy(item.id)}
                      disabled={busy === item.id || (shop?.coins ?? 0) < item.price}
                      title={
                        (shop?.coins ?? 0) < item.price
                          ? `Не хватает ${item.price - (shop?.coins ?? 0)} G-коинов`
                          : undefined
                      }
                    >
                      <img className="coin" src={coin} alt="" />
                      {item.price}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <small>
          Купленное сразу попадает в библиотеку — надеть можно на странице
          аккаунта.
        </small>
      </div>
    </section>
  );
}
