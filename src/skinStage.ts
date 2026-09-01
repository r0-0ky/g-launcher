import { SkinViewer } from "skinview3d";

/**
 * Единственный живой просмотрщик на весь лаунчер.
 *
 * Каждый SkinViewer поднимает свой контекст WebGL, а WebKit держит их на
 * страницу считанные штуки и слот освобождает не сразу. Когда счёт исчерпан,
 * новый контекст приходит уже потерянным, и three.js падает прямо в
 * конструкторе — `getShaderPrecisionFormat` возвращает null. Роняло это всё
 * окно, а не одну модель.
 *
 * Поэтому просмотрщик один на всех: его холст переезжает в тот экран, который
 * сейчас показывает модель, и контекст живёт до конца работы лаунчера.
 */

let stage: SkinViewer | null = null;
/** Про неудачу говорим один раз — иначе консоль забивается на каждый экран. */
let complained = false;

function contextLost(viewer: SkinViewer): boolean {
  try {
    return viewer.renderer.getContext().isContextLost();
  } catch {
    return true;
  }
}

/**
 * Живой просмотрщик под нужный размер, приведённый в исходное состояние.
 * null — WebGL не дался, звать снова можно, показывать пока нечего.
 */
export function takeStage(width: number, height: number): SkinViewer | null {
  if (stage && contextLost(stage)) stage = null;

  if (!stage) {
    try {
      stage = new SkinViewer({
        canvas: document.createElement("canvas"),
        width,
        height,
      });
    } catch (error) {
      if (!complained) {
        complained = true;
        console.error("WebGL не поднялся — живой просмотр недоступен", error);
      }
      return null;
    }
  }

  // Прошлый экран мог оставить свою позу, поворот, наклон камеры и разворот —
  // просмотрщик общий, поэтому каждый раз начинаем с чистого листа.
  stage.animation = null;
  stage.playerObject.resetJoints();
  stage.playerWrapper.rotation.set(0, 0, 0);
  stage.autoRotate = false;
  stage.controls.enableZoom = false;
  stage.controls.enablePan = false;
  stage.controls.enableRotate = true;
  stage.controls.minPolarAngle = 0;
  stage.controls.maxPolarAngle = Math.PI;
  stage.controls.target.set(0, 0, 0);
  stage.resetCameraPose();
  stage.controls.update();
  stage.setSize(width, height);
  stage.renderPaused = false;
  return stage;
}

/**
 * Экран закрылся: холст убираем из разметки, контекст держим — он у нас один.
 * Если холст успел переехать на другой экран, уходим молча: там он нужен живым.
 */
export function releaseStage(viewer: SkinViewer, holder: HTMLElement): void {
  if (viewer !== stage || viewer.canvas.parentElement !== holder) return;
  viewer.renderPaused = true;
  viewer.autoRotate = false;
  viewer.animation = null;
  viewer.resetSkin();
  viewer.resetCape();
  viewer.canvas.remove();
}
