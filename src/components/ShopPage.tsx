import { useEffect, useState } from "react";
import type { Shop, ShopItem } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";
import { PurchaseReveal } from "./PurchaseReveal";
import { Loader } from "./Loader";
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
  /** Открытая карточка: показываем вещь крупно, её можно покрутить. */
  const [picked, setPicked] = useState<number | null>(null);
  const shown = shop?.items.find((item) => item.id === picked) ?? null;
  /** Только что купленное: показываем крупно, пока игрок не закроет. */
  const [won, setWon] = useState<{ item: ShopItem; textureId: number | null } | null>(null);

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

  // Из просмотра вещи выходим по Escape или щелчком мимо неё.
  useEffect(() => {
    if (picked === null) return;

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicked(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [picked]);

  async function buy(id: number) {
    setBusy(id);
    setError(null);
    try {
      const item = shop?.items.find((row) => row.id === id) ?? null;
      const library = await api.glandBuy(id);

      // Вещь в библиотеке узнаём по картинке: адрес у неё тот же, что на витрине.
      const texture = [...library.skins, ...library.capes].find(
        (row) => row.url === item?.url
      );
      if (item) setWon({ item, textureId: texture?.id ?? null });

      setPicked(null);
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

      {won && (
        <PurchaseReveal
          item={won.item}
          textureId={won.textureId}
          wearing={shop?.wearing ?? null}
          onClose={() => {
            setWon(null);
            onBought?.();
          }}
        />
      )}

      {shown && (
        <div
          className={`shop-detail rarity-${shown.rarity}`}
          onClick={(event) => {
            // Клик мимо вещи — возврат на витрину: отдельной кнопки нет.
            if (event.target === event.currentTarget) setPicked(null);
          }}
        >
          <div className="shop-detail-info">
            <h3>{shown.name}</h3>
            <span className="shop-card-price">
              <img className="coin" src={coin} alt="" />
              {shown.price}
            </span>
            <span className="muted small">{RARITY_NAMES[shown.rarity] ?? shown.rarity}</span>

            <div className="shop-detail-actions">
              {shown.owned ? (
                <span className="shop-card-owned">Куплено</span>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => buy(shown.id)}
                  disabled={busy === shown.id || (shop?.coins ?? 0) < shown.price}
                  title={
                    (shop?.coins ?? 0) < shown.price
                      ? `Не хватает ${shown.price - (shop?.coins ?? 0)} G-коинов`
                      : undefined
                  }
                >
                  {busy === shown.id ? "Покупаем…" : "Купить"}
                </Button>
              )}
            </div>
          </div>

          {/* Модель стоит на плите — иначе кажется, что она висит в воздухе. */}
          <div className="shop-detail-stage">
            <div className="shop-stage">
            <SkinPreview
              skin={shown.kind === "cape" ? (shop?.wearing?.skin ?? null) : shown.url}
              cape={shown.kind === "cape" ? shown.url : null}
              model={shown.kind === "cape" ? (shop?.wearing?.model ?? "classic") : shown.model}
              width={320}
              height={440}
              pose
              angle={shown.kind === "cape" ? 2.4 : -0.5}
            />
            </div>
            <div className="shop-stage-hint muted small">Покрутите мышью</div>
          </div>
        </div>
      )}

      {!shown && (
      <div className="account-main">
        {!shop && !error && <Loader label="Открываем витрину…" />}

        {shop && shop.items.length === 0 && (
          <span className="muted">Витрина пока пуста — загляните позже</span>
        )}

        {!!shop?.items.length && (
          <div className="shop-grid">
            {shop.items.map((item) => (
              <div
                key={item.id}
                className={`shop-card rarity-${item.rarity}`}
                onClick={() => setPicked(item.id)}
                role="button"
                tabIndex={0}
              >
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
                    width={240}
                    height={310}
                    locked
                    bust
                    pose
                    angle={item.kind === "cape" ? 2.4 : -0.5}
                  />
                </div>

                <div className="shop-card-foot">
                  <div className="shop-card-name">{item.name}</div>
                  {item.owned ? (
                    <span className="shop-card-owned">Куплено</span>
                  ) : (
                    <span className="shop-card-price">
                      <img className="coin" src={coin} alt="" />
                      {item.price}
                    </span>
                  )}
                </div>

                {/* Кнопка выезжает снизу под курсором: в покое карточку не
                    загромождает, а купить можно не уходя с витрины. */}
                {!item.owned && (
                  <div className="shop-card-buy" onClick={(event) => event.stopPropagation()}>
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
                      {busy === item.id ? "Покупаем…" : "Купить"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <small>
          Купленное сразу попадает в библиотеку — надеть можно на странице
          аккаунта.
        </small>
      </div>
      )}
    </section>
  );
}
