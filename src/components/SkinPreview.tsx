import { useEffect, useRef } from "react";
import { IdleAnimation, SkinViewer } from "skinview3d";

/**
 * Объёмный предпросмотр скина: то же, что видно в игре, только можно
 * покрутить мышью. Плащ, если надет, показывается вместе со скином.
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
  locked = false,
  bust = false,
  angle = 0,
  pose = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);

  // Просмотрщик создаётся один раз: пересоздавать его на каждую смену скина —
  // значит каждый раз поднимать заново весь WebGL-контекст.
  useEffect(() => {
    if (!canvasRef.current) return;

    const viewer = new SkinViewer({ canvas: canvasRef.current, width, height });
    viewer.animation = pose ? null : new IdleAnimation();
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
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

    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [width, height, rotate, locked, bust, angle, pose]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (skin) {
      // В библиотеке модель зовётся classic/slim, в просмотрщике — default/slim.
      void viewer.loadSkin(skin, { model: model === "slim" ? "slim" : "default" });
    } else {
      viewer.resetSkin();
    }
  }, [skin, model]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (cape) void viewer.loadCape(cape);
    else viewer.resetCape();
  }, [cape]);

  return <canvas className="skin-preview" ref={canvasRef} width={width} height={height} />;
}
