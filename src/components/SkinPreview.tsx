import { useEffect, useRef, useState } from "react";
import { IdleAnimation, type SkinViewer } from "skinview3d";
import { releaseStage, takeStage } from "../skinStage";

/**
 * Объёмный предпросмотр скина: то же, что видно в игре, только можно
 * покрутить мышью. Плащ, если надет, показывается вместе со скином.
 *
 * Своего холста у предпросмотра нет: на весь лаунчер один живой просмотрщик,
 * и его холст переезжает сюда, пока экран открыт (см. skinStage).
 */
interface Props {
  /** Адрес текстуры скина. Пусто — показывать нечего. */
  skin: string | null;
  cape: string | null;
  model: "classic" | "slim";
  width?: number;
  height?: number;
  /** Модель сама поворачивается — так на витрине видно и спину, и плащ. */
  rotate?: boolean;
  /** Показ покупки: раскрутить волчком и остановить строго на нужном угле. */
  reveal?: boolean;
  /** Мышью крутить нельзя: на маленьких плитках это только мешает. */
  locked?: boolean;
  /** Кадр по пояс: на витрине важно лицо и торс, а не ботинки. */
  bust?: boolean;
  /** Разворот модели в радианах: плащ видно только со спины. */
  angle?: number;
  /** Витринная поза вместо покачивания: модель стоит неподвижно. */
  pose?: boolean;
}

export function SkinPreview({
  skin,
  cape,
  model,
  width = 180,
  height = 260,
  rotate = false,
  reveal = false,
  locked = false,
  bust = false,
  angle = 0,
  pose = false,
}: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  // Счётчик заездов просмотрщика: по нему заново грузятся скин и плащ, ведь
  // при возврате холста общий просмотрщик отдаёт текстуры.
  const [claimed, setClaimed] = useState(0);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    // Общий просмотрщик мог не подняться — тогда на месте модели остаётся
    // пустая ниша, но экран работает как ни в чём не бывало.
    const viewer = takeStage(width, height);
    if (!viewer) return;

    holder.appendChild(viewer.canvas);
    viewer.animation = pose ? null : new IdleAnimation();
    viewer.controls.enableRotate = !locked;
    viewer.autoRotate = rotate;
    viewer.autoRotateSpeed = 1.2;
    viewer.zoom = bust ? 1.45 : 0.85;
    viewer.playerWrapper.rotation.y = angle;

    if (pose) {
      // Руки чуть отведены, ноги в лёгком шаге — иначе модель стоит по стойке
      // смирно и выглядит как манекен.
      const body = viewer.playerObject.skin;
      body.leftArm.rotation.set(-0.12, 0, 0.14);
      body.rightArm.rotation.set(0.12, 0, -0.14);
      body.leftLeg.rotation.x = 0.16;
      body.rightLeg.rotation.x = -0.16;
    }
    if (bust) {
      // Камера смотрит выше пояса — ноги уходят за нижний край кадра.
      viewer.controls.target.set(0, 5, 0);
      viewer.controls.update();
    }
    // Крутить даём только вокруг вертикальной оси: камера остаётся на уровне
    // глаз и ходит по кругу, а не заваливается сверху или снизу.
    if (!locked) {
      const level = Math.PI / 2;
      viewer.controls.minPolarAngle = level;
      viewer.controls.maxPolarAngle = level;
    }

    viewerRef.current = viewer;
    setClaimed((count) => count + 1);

    return () => {
      viewerRef.current = null;
      releaseStage(viewer, holder);
    };
  }, [width, height, rotate, locked, bust, angle, pose]);

  // Раскрутка при покупке: несколько быстрых оборотов, которые тормозят и
  // замирают ровно на заданном угле — чтобы вещь осталась стоять лицом.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!reveal || !viewer) return;

    const SPINS = 6;
    const MS = 2600;
    const started = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const time = Math.min(1, (now - started) / MS);
      const eased = 1 - Math.pow(1 - time, 3);
      viewer.playerWrapper.rotation.y = angle + (1 - eased) * SPINS * Math.PI * 2;
      if (time < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reveal, angle, claimed]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (skin) {
      // В библиотеке модель зовётся classic/slim, в просмотрщике — default/slim.
      void viewer.loadSkin(skin, { model: model === "slim" ? "slim" : "default" });
    } else {
      viewer.resetSkin();
    }
  }, [skin, model, claimed]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (cape) void viewer.loadCape(cape);
    else viewer.resetCape();
  }, [cape, claimed]);

  return <div className="skin-preview" ref={holderRef} style={{ width, height }} />;
}
