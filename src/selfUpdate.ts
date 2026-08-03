import { useCallback, useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** Обновление самого лаунчера: проверка при старте, загрузка, установка, перезапуск. */
export type SelfUpdateStage = "idle" | "available" | "downloading" | "installing" | "failed";

export interface SelfUpdateState {
  stage: SelfUpdateStage;
  /** Версия, которую предлагаем поставить. */
  version: string | null;
  /** Описание релиза из latest.json. */
  notes: string | null;
  /** 0..1, пока идёт загрузка; null — если сервер не отдал размер. */
  progress: number | null;
  error: string | null;
  install: () => void;
  dismiss: () => void;
}

type State = Omit<SelfUpdateState, "install" | "dismiss">;

const empty: State = {
  stage: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
};

export function useSelfUpdate(): SelfUpdateState {
  const [state, setState] = useState(empty);
  const [update, setUpdate] = useState<Update | null>(null);

  useEffect(() => {
    // В браузерном `npm run dev` плагина нет — молча пропускаем.
    if (!("__TAURI_INTERNALS__" in window)) return;

    let cancelled = false;
    void (async () => {
      try {
        const found = await check();
        if (cancelled || !found) return;
        setUpdate(found);
        setState({
          ...empty,
          stage: "available",
          version: found.version,
          notes: found.body ?? null,
        });
      } catch {
        // Нет сети или эндпоинт недоступен — не мешаем играть.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(() => {
    if (!update) return;
    void (async () => {
      let total = 0;
      let received = 0;
      setState((prev) => ({ ...prev, stage: "downloading", progress: null, error: null }));
      try {
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? 0;
              break;
            case "Progress":
              received += event.data.chunkLength;
              setState((prev) => ({
                ...prev,
                progress: total > 0 ? Math.min(received / total, 1) : null,
              }));
              break;
            case "Finished":
              setState((prev) => ({ ...prev, stage: "installing", progress: 1 }));
              break;
          }
        });
        await relaunch();
      } catch (err) {
        setState((prev) => ({
          ...prev,
          stage: "failed",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
  }, [update]);

  const dismiss = useCallback(() => {
    setState((prev) => ({ ...prev, stage: "idle" }));
  }, []);

  return { ...state, install, dismiss };
}
