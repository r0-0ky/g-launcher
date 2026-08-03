import { useCallback, useEffect, useRef, useState } from "react";
import introVideo from "../assets/intro.mp4";

/**
 * Стартовая заставка: беззвучное видео на весь экран. Заглавная песня играет
 * отдельно (в App), чтобы не прерываться после конца заставки. Когда видео
 * заканчивается или его пропускают кликом, заставка гаснет, а интерфейс
 * проявляется снизу.
 */
export function Intro({ onFinish }: { onFinish: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    setLeaving(true);
    // Даём отыграть CSS-переходу исчезновения, затем убираем оверлей.
    setTimeout(onFinish, 900);
  }, [onFinish]);

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
        onEnded={finish}
      />
      <div className="intro-skip">нажмите, чтобы пропустить</div>
    </div>
  );
}
