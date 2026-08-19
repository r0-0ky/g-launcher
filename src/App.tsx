import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bootstrap,
  GameStateEvent,
  LogEvent,
  Manifest,
  ProgressEvent,
  UpdateReport,
} from "./api";
import { api, errorText, events } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ModeView } from "./components/ModeView";
import { Console } from "./components/Console";
import { SettingsDialog } from "./components/SettingsDialog";
import { AccountDialog } from "./components/AccountDialog";
import { Bubbles, Snail, Sponge, Starfish, Jellyfish } from "./components/decor";
import { Intro } from "./components/Intro";
import { UpdateBanner } from "./components/UpdateBanner";
import { useSelfUpdate } from "./selfUpdate";
import themeAudio from "./assets/theme.mp3";
import { Button } from "./components/McButton";
import { Alert, Close, VolumeOff, VolumeOn } from "./components/icons";

const MAX_LOG_LINES = 800;

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, UpdateReport>>({});
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  // Взводится, когда пошёл первый кадр заставки — по нему стартует песня.
  const [introStarted, setIntroStarted] = useState(false);
  // Выбор «музыка выкл» запоминается между запусками.
  const [musicOff, setMusicOff] = useState(() => localStorage.getItem("gandoni-music-off") === "1");
  const musicRef = useRef<HTMLAudioElement>(null);

  const selfUpdate = useSelfUpdate();

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const modes = manifest?.modes ?? [];
  const selected = useMemo(
    () => modes.find((mode) => mode.id === selectedId) ?? null,
    [modes, selectedId]
  );
  const account = useMemo(() => {
    if (!bootstrap) return null;
    return bootstrap.accounts.find((item) => item.id === bootstrap.activeAccount) ?? null;
  }, [bootstrap]);

  const refreshReport = useCallback(async (modeId: string, verify = false) => {
    try {
      const report = await api.checkUpdates(modeId, verify);
      setReports((prev) => ({ ...prev, [modeId]: report }));
      return report;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, []);

  const loadManifest = useCallback(
    async (force: boolean) => {
      setRefreshing(true);
      try {
        const loaded = await api.fetchManifest(force);
        setManifest(loaded);
        setError(null);

        const current = selectedRef.current;
        const stillThere = current && loaded.modes.some((mode) => mode.id === current);
        if (!stillThere) {
          setSelectedId(loaded.modes[0]?.id ?? null);
        }
        for (const mode of loaded.modes) {
          void refreshReport(mode.id);
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setRefreshing(false);
      }
    },
    [refreshReport]
  );

  useEffect(() => {
    (async () => {
      try {
        const data = await api.bootstrap();
        setBootstrap(data);
        if (data.settings.lastMode) setSelectedId(data.settings.lastMode);
        setRunning(await api.isGameRunning());
      } catch (err) {
        setError(errorText(err));
      }
      void loadManifest(false);
    })();
  }, [loadManifest]);

  // Заглавная песня: «включено» — реально играем (зациклено), «выключено» — пауза.
  // Управляем play/pause явно, иначе после выключения звук не возвращается.
  useEffect(() => {
    const audio = musicRef.current;
    if (!audio) return;
    localStorage.setItem("gandoni-music-off", musicOff ? "1" : "0");

    if (musicOff) {
      audio.pause();
      return;
    }

    // До первого кадра заставки не играем: иначе песня уходит вперёд видео.
    if (!introStarted) return;

    audio.muted = false;
    audio.volume = 0.5;
    // Клик по кнопке — это уже жест, поэтому play() почти всегда проходит.
    // На самом старте (до первого клика) автозапуск может блокироваться —
    // тогда стартуем по первому действию пользователя.
    audio.play().catch(() => {
      const start = () => {
        if (!localStorage.getItem("gandoni-music-off")?.startsWith("1")) {
          void audio.play().catch(() => undefined);
        }
      };
      window.addEventListener("pointerdown", start, { once: true });
      window.addEventListener("keydown", start, { once: true });
    });
  }, [musicOff, introStarted]);

  // Момент, когда видео заставки реально пошло: отматываем песню в начало,
  // чтобы она и картинка стартовали с одной точки.
  const handleIntroStart = useCallback(() => {
    const audio = musicRef.current;
    if (audio) audio.currentTime = 0;
    setIntroStarted(true);
  }, []);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      events.onProgress((event: ProgressEvent) => setProgress(event)),
      events.onGameState((event: GameStateEvent) => {
        setRunning(event.running);
        if (!event.running) setProgress(null);
      }),
      events.onLog((event: LogEvent) =>
        setLogs((prev) => {
          const next = [...prev, event];
          return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
        })
      ),
    ];
    return () => {
      unlisteners.forEach((promise) => promise.then((off) => off()));
    };
  }, []);

  async function runTask(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(errorText(err));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  const handlePlay = () => {
    if (!selected) return;
    if (!account) {
      setShowAccounts(true);
      return;
    }
    void runTask(async () => {
      setLogs([]);
      await api.play(selected.id, false);
      await refreshReport(selected.id);
    });
  };

  const handleUpdate = () => {
    if (!selected) return;
    void runTask(async () => {
      await api.install(selected.id, false);
      await refreshReport(selected.id);
    });
  };

  const handleVerify = () => {
    if (!selected) return;
    void runTask(async () => {
      await api.install(selected.id, true);
      await refreshReport(selected.id, true);
    });
  };

  const handleStop = () => {
    void api.stopGame().catch((err) => setError(errorText(err)));
  };

  const handleDelete = () => {
    if (!selected) return;
    const confirmed = window.confirm(
      `Удалить папку режима «${selected.name}»? Миры и настройки этой сборки будут стёрты.`
    );
    if (!confirmed) return;
    void runTask(async () => {
      await api.deleteMode(selected.id);
      await refreshReport(selected.id);
    });
  };

  const updatable = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const [id, report] of Object.entries(reports)) {
      map[id] = report.installed && report.needsUpdate;
    }
    return map;
  }, [reports]);

  return (
    <>
      {/* Живёт всё время работы лаунчера — музыка не прерывается между экранами. */}
      <audio ref={musicRef} src={themeAudio} loop preload="auto" />

      {!introDone && <Intro onStart={handleIntroStart} onFinish={() => setIntroDone(true)} />}
      <div className={`app${introDone ? " revealed" : " pre-intro"}`}>
      <Bubbles />
      <Sidebar
        modes={modes}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          void refreshReport(id);
        }}
        account={account}
        onAccountClick={() => setShowAccounts(true)}
        onSettingsClick={() => setShowSettings(true)}
        onRefresh={() => void loadManifest(true)}
        refreshing={refreshing}
        updatable={updatable}
      />

      <main className="content">
        <UpdateBanner update={selfUpdate} />

        {error && (
          <div className="error banner">
            <Alert className="error-mark" />
            <span>{error}</span>
            <Button variant="clear" onClick={() => setError(null)} title="Скрыть">
              <Close />
            </Button>
          </div>
        )}

        {selected ? (
          <ModeView
            mode={selected}
            report={reports[selected.id] ?? null}
            progress={progress}
            busy={busy}
            running={running}
            onPlay={handlePlay}
            onUpdate={handleUpdate}
            onVerify={handleVerify}
            onStop={handleStop}
            onOpenFolder={() => void api.openModeFolder(selected.id)}
            onDelete={handleDelete}
          />
        ) : (
          <div className="placeholder-view">
            <div className="placeholder-mascots">
              <Sponge />
              <Jellyfish />
              <Starfish />
            </div>
            <h2>Режимы не загружены</h2>
            <p>
              Проверьте адрес манифеста в настройках и нажмите «Обновить» в списке слева.
            </p>
            <Button variant="secondary" onClick={() => setShowSettings(true)}>
              Открыть настройки
            </Button>
          </div>
        )}

        <Console
          lines={logs}
          open={consoleOpen}
          onToggle={() => setConsoleOpen((value) => !value)}
          onClear={() => setLogs([])}
        />
      </main>

      {showSettings && bootstrap && (
        <SettingsDialog
          settings={bootstrap.settings}
          gameRoot={bootstrap.gameRoot}
          onClose={() => setShowSettings(false)}
          onSaved={(settings) => {
            setBootstrap({ ...bootstrap, settings });
            setShowSettings(false);
            void loadManifest(true);
          }}
        />
      )}

      {showAccounts && bootstrap && (
        <AccountDialog
          accounts={bootstrap.accounts}
          activeId={bootstrap.activeAccount}
          onClose={() => setShowAccounts(false)}
          onChanged={(next) => setBootstrap(next)}
        />
      )}

      <Snail className="corner-buddy" />

      <button
        className="music-toggle"
        onClick={() => setMusicOff((value) => !value)}
        title={musicOff ? "Включить музыку" : "Выключить музыку"}
      >
        {musicOff ? <VolumeOff /> : <VolumeOn />}
      </button>
      </div>
    </>
  );
}
