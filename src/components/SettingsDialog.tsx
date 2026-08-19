import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";

interface Props {
  settings: Settings;
  gameRoot: string;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

export function SettingsDialog({ settings, gameRoot, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (values: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...values }));

  async function pickFolder(kind: "root" | "java") {
    const selected = await open({
      directory: kind === "root",
      multiple: false,
      title: kind === "root" ? "Папка для игры" : "Исполняемый файл Java",
    });
    if (typeof selected === "string") {
      patch(kind === "root" ? { rootDir: selected } : { javaPath: selected });
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(draft);
      onSaved(draft);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <h2>Настройки</h2>

        <label className="field">
          <span>Адрес манифеста</span>
          <input
            value={draft.manifestUrl}
            onChange={(event) => patch({ manifestUrl: event.target.value })}
            placeholder="https://example.com/manifest.json"
          />
          <small>URL или локальный путь к JSON со списком режимов.</small>
        </label>

        <label className="field">
          <span>Папка игры</span>
          <div className="row">
            <input
              value={draft.rootDir ?? ""}
              onChange={(event) => patch({ rootDir: event.target.value || null })}
              placeholder={gameRoot}
            />
            <Button variant="secondary" onClick={() => pickFolder("root")}>
              Выбрать
            </Button>
          </div>
        </label>

        <label className="field">
          <span>Оперативная память: {draft.memoryMb} МБ</span>
          <input
            type="range"
            min={1024}
            max={16384}
            step={512}
            value={draft.memoryMb}
            onChange={(event) => patch({ memoryMb: Number(event.target.value) })}
          />
          <small>Режим может задать своё значение — оно имеет приоритет.</small>
        </label>

        <label className="field">
          <span>Путь к Java</span>
          <div className="row">
            <input
              value={draft.javaPath ?? ""}
              onChange={(event) => patch({ javaPath: event.target.value || null })}
              placeholder="Оставьте пустым — лаунчер скачает нужную версию сам"
            />
            <Button variant="secondary" onClick={() => pickFolder("java")}>
              Выбрать
            </Button>
          </div>
        </label>

        <label className="field">
          <span>Аргументы JVM</span>
          <input
            value={draft.jvmArgs}
            onChange={(event) => patch({ jvmArgs: event.target.value })}
          />
        </label>

        <label className="field">
          <span>Client ID приложения Microsoft</span>
          <input
            value={draft.msClientId}
            onChange={(event) => patch({ msClientId: event.target.value })}
            placeholder="нужен только для входа по лицензии"
          />
          <small>
            Необязательно: если пусто, берётся ID, зашитый в лаунчер на сборке. Своё
            значение переопределяет его. Azure Portal → App registrations, включить
            «Allow public client flows».
          </small>
        </label>

        <div className="checks">
          <label>
            <input
              type="checkbox"
              checked={draft.fullscreen}
              onChange={(event) => patch({ fullscreen: event.target.checked })}
            />
            Запускать в полноэкранном режиме
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.autoConnect}
              onChange={(event) => patch({ autoConnect: event.target.checked })}
            />
            Сразу подключаться к серверу режима
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.closeLauncherOnStart}
              onChange={(event) => patch({ closeLauncherOnStart: event.target.checked })}
            />
            Сворачивать лаунчер после запуска игры
          </label>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <Button variant="secondary" onClick={() => api.openGameRoot()}>
            Открыть папку игры
          </Button>
          <div className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" className="small" onClick={save} disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>
  );
}
