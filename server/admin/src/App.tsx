import { useCallback, useEffect, useState } from "react";
import type { Mode, ModeDetail, ModeSummary } from "./api";
import { api, errorText, getToken, setToken } from "./api";
import { Login } from "./components/Login";
import { ModeForm } from "./components/ModeForm";
import { ContentTab } from "./components/ContentTab";

type Tab = "main" | "content";

function slugify(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  return value
    .toLowerCase()
    .split("")
    .map((char) => map[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [modes, setModes] = useState<ModeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModeDetail | null>(null);
  const [draft, setDraft] = useState<Mode | null>(null);
  const [tab, setTab] = useState<Tab>("main");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newMode, setNewMode] = useState({ name: "", minecraft: "1.20.1" });

  const loadModes = useCallback(async () => {
    try {
      const list = await api.modes();
      setModes(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (err) {
      if (errorText(err).includes("Сессия")) setAuthed(false);
      else setError(errorText(err));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.mode(id);
      setDetail(data);
      setDraft(data);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (authed) void loadModes();
  }, [authed, loadModes]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  if (!authed) {
    return <Login onDone={() => setAuthed(true)} />;
  }

  // Черновик — копия загруженной сборки, поэтому сравниваем целиком.
  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(detail);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveMode(draft.id, draft);
      setNotice("Сохранено");
      await loadModes();
      await loadDetail(draft.id);
      setTimeout(() => setNotice(null), 2000);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleVisible() {
    if (!draft) return;
    const next = { ...draft, visible: !draft.visible };
    setDraft(next);
    try {
      await api.saveMode(next.id, next);
      await loadModes();
      setNotice(next.visible ? "Сборка видна в лаунчере" : "Сборка скрыта");
      setTimeout(() => setNotice(null), 2000);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function createMode() {
    const id = slugify(newMode.name);
    if (!id) {
      setError("Название должно содержать латиницу или цифры");
      return;
    }
    try {
      await api.createMode({
        id,
        name: newMode.name,
        description: "",
        minecraft: newMode.minecraft,
        loaderType: "fabric",
        visible: false,
        syncPaths: ["mods", "config", "shaderpacks", "resourcepacks"],
        keep: [],
      });
      setCreating(false);
      setNewMode({ name: "", minecraft: "1.20.1" });
      await loadModes();
      setSelectedId(id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function removeMode() {
    if (!detail) return;
    if (!window.confirm(`Удалить сборку «${detail.name}» вместе с файлами?`)) return;
    try {
      await api.deleteMode(detail.id);
      setSelectedId(null);
      setDetail(null);
      await loadModes();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function duplicate() {
    if (!detail) return;
    const name = window.prompt("Название копии", `${detail.name} (копия)`);
    if (!name) return;
    try {
      const id = slugify(name);
      await api.duplicateMode(detail.id, id, name);
      await loadModes();
      setSelectedId(id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const manifestUrl = modes[0]?.manifestUrl ?? `${location.origin}/manifest.json`;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div>
            <div className="brand-title">Gandoni</div>
            <div className="muted small">админка сборок</div>
          </div>
        </div>

        <button className="primary block" onClick={() => setCreating(true)}>
          + Новая сборка
        </button>

        <div className="mode-list">
          {modes.map((mode) => (
            <button
              key={mode.id}
              className={`mode-item${mode.id === selectedId ? " active" : ""}`}
              onClick={() => setSelectedId(mode.id)}
            >
              <div className="mode-item-text">
                <div className="mode-item-name">{mode.name}</div>
                <div className="muted small">
                  {mode.minecraft} · {mode.loaderType} · {mode.filesCount} файл.
                </div>
              </div>
              <span className={`dot${mode.visible ? " on" : ""}`} title={mode.visible ? "видна" : "скрыта"} />
            </button>
          ))}
          {modes.length === 0 && <div className="muted small">Сборок пока нет</div>}
        </div>

        <div className="sidebar-footer">
          <button
            className="ghost block"
            onClick={() => {
              navigator.clipboard.writeText(manifestUrl);
              setNotice("Ссылка манифеста скопирована");
              setTimeout(() => setNotice(null), 2000);
            }}
          >
            Ссылка для лаунчера
          </button>
          <button
            className="link"
            onClick={async () => {
              await api.logout();
              setToken(null);
              setAuthed(false);
            }}
          >
            Выйти
          </button>
        </div>
      </aside>

      <main className="content">
        {(error || notice) && (
          <div className={error ? "error banner" : "notice banner"}>
            <span>{error ?? notice}</span>
            {error && (
              <button className="link" onClick={() => setError(null)}>
                ✕
              </button>
            )}
          </div>
        )}

        {draft && detail ? (
          <>
            <header className="page-head">
              <div>
                <h1>{draft.name}</h1>
                <div className="muted small">
                  id: {draft.id} · {detail.files.length} файлов
                </div>
              </div>
              <div className="head-actions">
                <button
                  className={draft.visible ? "toggle on" : "toggle"}
                  onClick={toggleVisible}
                  title="Показывать сборку в лаунчере"
                >
                  {draft.visible ? "● Видна в лаунчере" : "○ Скрыта"}
                </button>
                <button className="ghost" onClick={duplicate}>
                  Клонировать
                </button>
                <button className="ghost danger" onClick={removeMode}>
                  Удалить
                </button>
                <button className="primary" onClick={save} disabled={saving || !dirty}>
                  {saving ? "Сохраняем…" : dirty ? "Сохранить" : "Сохранено"}
                </button>
              </div>
            </header>

            <nav className="tabs">
              <button
                className={tab === "main" ? "tab active" : "tab"}
                onClick={() => setTab("main")}
              >
                Основное
              </button>
              <button
                className={tab === "content" ? "tab active" : "tab"}
                onClick={() => setTab("content")}
              >
                Содержимое
              </button>
            </nav>

            {tab === "main" ? (
              <div className="card">
                <ModeForm mode={draft} onChange={setDraft} />
              </div>
            ) : (
              <ContentTab mode={detail} onReload={() => loadDetail(detail.id)} />
            )}
          </>
        ) : (
          <div className="placeholder">
            <h2>Выберите сборку слева</h2>
            <p className="muted">или создайте новую</p>
          </div>
        )}
      </main>

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Новая сборка</h2>
            <label className="field">
              <span>Название</span>
              <input
                autoFocus
                value={newMode.name}
                onChange={(event) => setNewMode({ ...newMode, name: event.target.value })}
                placeholder="Выживание"
              />
              <small>id будет: {slugify(newMode.name) || "—"}</small>
            </label>
            <label className="field">
              <span>Версия Minecraft</span>
              <input
                value={newMode.minecraft}
                onChange={(event) => setNewMode({ ...newMode, minecraft: event.target.value })}
              />
            </label>
            <div className="modal-actions">
              <div className="spacer" />
              <button className="ghost" onClick={() => setCreating(false)}>
                Отмена
              </button>
              <button className="primary" onClick={createMode} disabled={!newMode.name.trim()}>
                Создать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
