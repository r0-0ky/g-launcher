import { useEffect, useState } from "react";
import type { ShopItem } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";
import { SkinPreview } from "./SkinPreview";

/**
 * Что показываем сразу после покупки: вещь вылетает из точки, раскручивается,
 * рассыпается кубиками — и её тут же можно надеть.
 */
interface Props {
  item: ShopItem;
  /** Та же вещь в библиотеке игрока: по ней надеваем. */
  textureId: number | null;
  /** Скин, на котором показываем плащи. */
  wearing: { skin: string; model: "classic" | "slim" } | null;
  onClose: () => void;
}

/** Кубики вспышки: разлетаются по кругу, у каждого свой угол и дальность. */
const SPARKS = Array.from({ length: 18 }, (_, index) => {
  const angle = (index / 18) * Math.PI * 2;
  const distance = 120 + (index % 4) * 34;
  return {
    dx: `${Math.cos(angle) * distance}px`,
    dy: `${Math.sin(angle) * distance}px`,
    delay: `${(index % 6) * 0.03}s`,
    size: 8 + (index % 3) * 5,
  };
});

export function PurchaseReveal({ item, textureId, wearing, onClose }: Props) {
  // Первые полсекунды вещь крутится волчком, потом успокаивается.
  const [speed, setSpeed] = useState(14);
  const [burst, setBurst] = useState(false);
  const [worn, setWorn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const spin = window.setTimeout(() => setSpeed(1.6), 900);
    const flash = window.setTimeout(() => setBurst(true), 420);
    return () => {
      window.clearTimeout(spin);
      window.clearTimeout(flash);
    };
  }, []);

  async function wear() {
    if (textureId === null) return;
    try {
      await api.glandSelectTexture(textureId);
      setWorn(true);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className={`reveal rarity-${item.rarity}`}>
      <div className="reveal-stage">
        <div className="reveal-model">
          <SkinPreview
            skin={item.kind === "cape" ? (wearing?.skin ?? null) : item.url}
            cape={item.kind === "cape" ? item.url : null}
            model={item.kind === "cape" ? (wearing?.model ?? "classic") : item.model}
            width={300}
            height={400}
            rotate
            spinSpeed={speed}
            locked
            pose
          />
        </div>

        {burst && (
          <div className="reveal-burst">
            {SPARKS.map((spark, index) => (
              <span
                key={index}
                className="spark"
                style={{
                  width: spark.size,
                  height: spark.size,
                  animationDelay: spark.delay,
                  ["--dx" as string]: spark.dx,
                  ["--dy" as string]: spark.dy,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="reveal-title">{item.name}</div>
      {error && <div className="error">{error}</div>}

      <div className="reveal-actions">
        <Button variant="primary" onClick={wear} disabled={textureId === null || worn}>
          {worn ? "Надето" : "Надеть"}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Получить
        </Button>
      </div>
    </div>
  );
}
