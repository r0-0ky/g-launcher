import type { Mode, ProgressEvent, UpdateReport } from "../api";
import { formatBytes, loaderLabel } from "../api";
import { Jellyfish, Starfish } from "./decor";
import { Button } from "./McButton";
import { Check, Folder, Play, Reload, Trash } from "./icons";

interface Props {
  mode: Mode;
  report: UpdateReport | null;
  progress: ProgressEvent | null;
  busy: boolean;
  running: boolean;
  onPlay: () => void;
  onUpdate: () => void;
  onVerify: () => void;
  onStop: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
}

function actionLabel(report: UpdateReport | null, running: boolean, busy: boolean) {
  if (running) return "Игра запущена";
  if (busy) return "Запуск";
  if (!report || !report.installed) return "Установить и играть";
  if (report.needsUpdate) return "Обновить и играть";
  return "Играть";
}

export function ModeView({
  mode,
  report,
  progress,
  busy,
  running,
  onPlay,
  onUpdate,
  onVerify,
  onStop,
  onOpenFolder,
  onDelete,
}: Props) {
  const percent = progress ? Math.round(progress.percent) : 0;

  return (
    <section className="mode-view">
      <header
        className="hero"
        style={mode.banner ? { backgroundImage: `url(${mode.banner})` } : undefined}
      >
        {!mode.banner && <Jellyfish className="hero-jelly" />}
        {!mode.banner && <Starfish className="hero-star" />}
        <div className="hero-overlay">
          <h1>{mode.name}</h1>
          <p>{mode.description}</p>
          <div className="chips">
            <span className="chip">Minecraft {mode.minecraft}</span>
            <span className="chip">{loaderLabel(mode)}</span>
            {mode.version && <span className="chip">Сборка {mode.version}</span>}
            <span className="chip">{mode.files.length} файлов</span>
            {mode.server && (
              <span className="chip">
                {mode.server.host}:{mode.server.port}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="status-card">
        {busy && progress ? (
          <>
            <div className="status-line">
              <strong>{progress.stage}</strong>
              <span>{percent}%</span>
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="status-detail">
              <span>{progress.message}</span>
              <span>
                {progress.filesTotal > 0 && `${progress.filesDone}/${progress.filesTotal} файлов`}
                {progress.bytesTotal > 0 &&
                  ` · ${formatBytes(progress.bytesDone)} из ${formatBytes(progress.bytesTotal)}`}
              </span>
            </div>
          </>
        ) : (
          <div className="status-summary">
            {report ? (
              report.needsUpdate ? (
                <>
                  <strong>{report.installed ? "Доступно обновление" : "Сборка не установлена"}</strong>
                  <span>
                    Скачать: {report.filesToDownload} файл(ов)
                    {report.downloadBytes > 0 && ` · ${formatBytes(report.downloadBytes)}`}
                    {report.filesToDelete > 0 && ` · удалить: ${report.filesToDelete}`}
                  </span>
                  {report.deleteNames.length > 0 && (
                    <span className="muted">Будут удалены: {report.deleteNames.slice(0, 6).join(", ")}
                      {report.deleteNames.length > 6 && " и др."}</span>
                  )}
                </>
              ) : (
                <>
                  <strong>Всё актуально</strong>
                  <span className="muted">Файлы сборки совпадают с манифестом</span>
                </>
              )
            ) : (
              <span className="muted">Проверяем состояние сборки…</span>
            )}
          </div>
        )}
      </div>

      <div className="actions">
        <Button variant="primary" onClick={onPlay} disabled={busy || running}>
          <Play />
          {actionLabel(report, running, busy)}
        </Button>
        {running ? (
          <Button variant="secondary" onClick={onStop}>
            Остановить игру
          </Button>
        ) : (
          <Button variant="secondary" onClick={onUpdate} disabled={busy}>
            <Reload />
            Только обновить
          </Button>
        )}
        <Button variant="secondary" onClick={onVerify} disabled={busy || running}>
          <Check />
          Проверить файлы
        </Button>
        <Button variant="secondary" onClick={onOpenFolder}>
          <Folder />
          Папка режима
        </Button>
        {/* Удалять нечего, пока сборка не установлена — кнопку не показываем вовсе. */}
        {report?.installed && (
          <Button variant="secondary" className="danger" onClick={onDelete} disabled={busy || running}>
            <Trash />
            Удалить
          </Button>
        )}
      </div>
    </section>
  );
}
