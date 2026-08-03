import type { SelfUpdateState } from "../selfUpdate";

/** Плашка «вышла новая версия лаунчера» поверх контента. */
export function UpdateBanner({ update }: { update: SelfUpdateState }) {
  if (update.stage === "idle") return null;

  const busy = update.stage === "downloading" || update.stage === "installing";
  const percent = update.progress === null ? null : Math.round(update.progress * 100);

  return (
    <div className="update-banner">
      <div className="update-banner-text">
        <strong>
          {update.stage === "failed"
            ? "Не удалось обновить лаунчер"
            : `Новая версия лаунчера ${update.version}`}
        </strong>
        {update.stage === "failed" && update.error && <span>{update.error}</span>}
        {update.stage === "available" && update.notes && <span>{update.notes}</span>}
        {update.stage === "downloading" && (
          <span>{percent === null ? "Качаем обновление…" : `Качаем обновление — ${percent}%`}</span>
        )}
        {update.stage === "installing" && <span>Устанавливаем, лаунчер сейчас перезапустится…</span>}
      </div>

      {busy && update.progress !== null && (
        <div className="progress update-banner-progress">
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}

      {!busy && (
        <div className="update-banner-actions">
          <button className="play-button small" onClick={update.install}>
            {update.stage === "failed" ? "Ещё раз" : "Обновить"}
          </button>
          <button className="ghost-button" onClick={update.dismiss}>
            Позже
          </button>
        </div>
      )}
    </div>
  );
}
