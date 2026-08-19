import { useCallback, useEffect, useRef, useState } from "react";
import introVideo from "../assets/intro.mp4";

/**
 * Стартовая заставка: беззвучное видео на весь экран. Заглавная песня играет
 * отдельно (в App), чтобы не прерываться после конца заставки. Когда видео
 * заканчивается или его пропускают кликом, заставка гаснет, а интерфейс
 * проявляется снизу.
 *
 * `onStart` дёргается в момент, когда видео реально пошло — по нему App
 * запускает песню, иначе звук и картинка расходятся: видео беззвучное и
 * стартует сразу, а автозапуск звука браузер может отложить.
 */
export function Intro({ onStart, onFinish }: { onStart: () => void; onFinish: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);
  const started = useRef(false);

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    onStart();
  }, [onStart]);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    // Заставку пропустили или видео не заиграло вовсе — песня всё равно должна начаться.
    start();
    setLeaving(true);
    // Даём отыграть CSS-переходу исчезновения, затем убираем оверлей.
    setTimeout(onFinish, 900);
  }, [onFinish, start]);

  useEffect(() => {
    void videoRef.current?.play().catch(() => undefined);
    // Страховка: если видео не отдало событие ended (битый файл и т.п.).
    const guard = setTimeout(finish, 60_000);
    return () => clearTimeout(guard);
  }, [finish]);

  return (
    <div
      className={`intro${leaving ? " leaving" : ""}`}
      onClick={finish}
      title="Нажмите, чтобы пропустить"
    >
      <video
        ref={videoRef}
        className="intro-video"
        src={introVideo}
        muted
        autoPlay
        playsInline
        preload="auto"
        onPlaying={start}
        onEnded={finish}
      />
      <div className="intro-skip">нажмите, чтобы пропустить</div>
    </div>
  );
}
