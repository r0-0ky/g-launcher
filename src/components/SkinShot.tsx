import { useEffect, useState } from "react";
import { SHOT_SCALE, skinShot } from "../skinShot";

/**
 * Модель картинкой — для витрины, где живых просмотрщиков было бы слишком
 * много. Пока снимок готовится, место занимает пустая рамка того же размера.
 */
interface Props {
  skin: string | null;
  cape: string | null;
  model: "classic" | "slim";
  angle: number;
  width: number;
  height: number;
  bust?: boolean;
}

export function SkinShot({ skin, cape, model, angle, width, height, bust }: Props) {
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    if (!skin) {
      setImage(null);
      return;
    }

    let alive = true;
    skinShot({
      skin,
      cape,
      model,
      angle,
      width: width * SHOT_SCALE,
      height: height * SHOT_SCALE,
      bust,
    })
      .then((shot) => {
        if (alive) setImage(shot);
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [skin, cape, model, angle, width, height, bust]);

  if (!image) return <div className="skin-shot" style={{ width, height }} />;
  return <img className="skin-shot" style={{ width, height }} src={image} alt="" draggable={false} />;
}
