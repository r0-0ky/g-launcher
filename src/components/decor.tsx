// Обитатели Бикини-Боттом — картинки-вырезки, лежат в src/assets.
import { useMemo } from "react";
import patrick from "../assets/patrick.png";
import spongebob from "../assets/spongebob.png";
import squidward from "../assets/squidward.png";

type MascotProps = { className?: string; style?: React.CSSProperties };

function Mascot({ src, alt, className, style }: MascotProps & { src: string; alt: string }) {
  return (
    <img
      className={`mascot ${className ?? ""}`}
      style={style}
      src={src}
      alt={alt}
      draggable={false}
    />
  );
}

/** Патрик — розовая морская звезда. */
export function Starfish(props: MascotProps) {
  return <Mascot {...props} src={patrick} alt="Патрик" />;
}

/** Спанч Боб — жёлтая губка. */
export function Sponge(props: MascotProps) {
  return <Mascot {...props} src={spongebob} alt="Спанч Боб" />;
}

/** Сквидвард (в баннере). */
export function Jellyfish(props: MascotProps) {
  return <Mascot {...props} src={squidward} alt="Сквидвард" />;
}

/** Сквидвард — плавающий помощник в углу. */
export function Snail(props: MascotProps) {
  return <Mascot {...props} src={squidward} alt="Сквидвард" />;
}

/** Всплывающие пузырьки — фон на весь экран. */
export function Bubbles({ count = 18 }: { count?: number }) {
  const bubbles = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => ({
        id: index,
        left: Math.random() * 100,
        size: 6 + Math.random() * 26,
        duration: 7 + Math.random() * 12,
        delay: Math.random() * 12,
      })),
    [count]
  );

  return (
    <div className="bubbles" aria-hidden>
      {bubbles.map((bubble) => (
        <span
          key={bubble.id}
          className="bubble"
          style={{
            left: `${bubble.left}%`,
            width: bubble.size,
            height: bubble.size,
            animationDuration: `${bubble.duration}s`,
            animationDelay: `-${bubble.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
