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
}

export function SkinPreview({ skin, cape, model, width = 180, height = 260 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);

  // Просмотрщик создаётся один раз: пересоздавать его на каждую смену скина —
  // значит каждый раз поднимать заново весь WebGL-контекст.
  useEffect(() => {
    if (!canvasRef.current) return;

    const viewer = new SkinViewer({ canvas: canvasRef.current, width, height });
    viewer.animation = new IdleAnimation();
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.zoom = 0.85;
    viewerRef.current = viewer;

    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [width, height]);

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
