import { SkinViewer } from "skinview3d";

/**
 * Снимок модели картинкой.
 *
 * Живой просмотрщик держит свой контекст WebGL, а их у страницы всего с
 * десяток: на витрине из полутора десятков карточек модели просто переставали
 * появляться. Карточки статичны, поэтому рисуем их одним общим движком по
 * очереди и отдаём готовый PNG.
 */

export interface ShotOptions {
  skin: string;
  cape: string | null;
  model: "classic" | "slim";
  /** Разворот модели в радианах. */
  angle: number;
  width: number;
  height: number;
  /** Кадр по пояс — как на карточках витрины. */
  bust?: boolean;
}

/** Рисуем вдвое крупнее и ужимаем в вёрстке: так пиксели остаются чёткими. */
export const SHOT_SCALE = 2;

let viewer: SkinViewer | null = null;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, string>();

function keyOf(options: ShotOptions): string {
  const { skin, cape, model, angle, width, height, bust } = options;
  return [skin, cape, model, angle, width, height, bust].join("|");
}

function ensureViewer(width: number, height: number): SkinViewer {
  if (!viewer) {
    viewer = new SkinViewer({
      canvas: document.createElement("canvas"),
      width,
      height,
      // Кадр снимаем вручную, поэтому цикл отрисовки не нужен, а буфер после
      // отрисовки должен сохраниться — иначе снимок выйдет пустым.
      renderPaused: true,
      preserveDrawingBuffer: true,
    });
    viewer.animation = null;
  }
  viewer.setSize(width, height);
  return viewer;
}

export function skinShot(options: ShotOptions): Promise<string> {
  const key = keyOf(options);
  const ready = cache.get(key);
  if (ready) return Promise.resolve(ready);

  const shot = queue.then(async () => {
    const cached = cache.get(key);
    if (cached) return cached;

    const view = ensureViewer(options.width, options.height);
    view.resetCape();
    await view.loadSkin(options.skin, {
      model: options.model === "slim" ? "slim" : "default",
    });
    if (options.cape) await view.loadCape(options.cape);

    view.zoom = options.bust ? 1.45 : 0.85;
    view.playerWrapper.rotation.y = options.angle;
    view.controls.target.set(0, options.bust ? 5 : 0, 0);
    view.controls.update();

    // Та же витринная поза, что и у живого просмотра.
    const body = view.playerObject.skin;
    body.leftArm.rotation.set(-0.12, 0, 0.14);
    body.rightArm.rotation.set(0.12, 0, -0.14);
    body.leftLeg.rotation.x = 0.16;
    body.rightLeg.rotation.x = -0.16;

    view.render();
    const image = view.canvas.toDataURL("image/png");
    cache.set(key, image);
    return image;
  });

  // Одна неудача не должна останавливать очередь остальных карточек.
  queue = shot.catch(() => undefined);
  return shot;
}
