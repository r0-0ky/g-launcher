import { useRef, useState } from "react";
import type { ContentKind, ModeDetail, ProjectType } from "../api";
import { api, errorText, formatBytes, KIND_LABELS } from "../api";
import { ModrinthDialog } from "./ModrinthDialog";

interface Props {
  mode: ModeDetail;
  onReload: () => void;
}

const SECTIONS: ContentKind[] = ["mod", "shader", "resourcepack", "config", "other"];
const MODRINTH_TYPES: Partial<Record<ContentKind, ProjectType>> = {
  mod: "mod",
  shader: "shader",
  resourcepack: "resourcepack",
};

/** Вкладка «Содержимое»: моды, шейдеры, ресурс-паки и свои файлы. */
export function ContentTab({ mode, onReload }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogType, setDialogType] = useState<ProjectType | null>(null);
  const inputs = useRef<Partial<Record<ContentKind, HTMLInputElement | null>>>({});

  async function upload(kind: ContentKind, files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFiles(mode.id, kind, files);
      onReload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      const input = inputs.current[kind];
      if (input) input.value = "";
    }
  }

  async function remove(fileId: number) {
    setError(null);
    try {
      await api.deleteFile(mode.id, fileId);
      onReload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function toggleOptional(fileId: number, optional: boolean) {
    try {
      await api.setOptional(mode.id, fileId, optional);
      onReload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="content-tab">
      {error && <div className="error">{error}</div>}

      {SECTIONS.map((kind) => {
        const files = mode.files.filter((file) => file.kind === kind);
        const modrinthType = MODRINTH_TYPES[kind];
        return (
          <section key={kind} className="card">
            <div className="section-head">
              <h3>
                {KIND_LABELS[kind]} <span className="muted small">{files.length}</span>
              </h3>
              <div className="section-actions">
                {modrinthType && (
                  <button className="ghost" onClick={() => setDialogType(modrinthType)}>
                    Из Modrinth
                  </button>
                )}
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => inputs.current[kind]?.click()}
                >
                  Загрузить файлы
                </button>
                <input
                  ref={(element) => {
                    inputs.current[kind] = element;
                  }}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => upload(kind, event.target.files)}
                />
              </div>
            </div>

            {files.length === 0 ? (
              <div className="muted small">Пусто</div>
            ) : (
              <table className="files">
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id}>
                      <td className="file-name">
                        {file.meta?.iconUrl && (
                          <img src={file.meta.iconUrl} alt="" className="project-icon tiny" />
                        )}
                        <div>
                          <div>{file.meta?.title ?? file.path.split("/").pop()}</div>
                          <div className="muted small">{file.path}</div>
                        </div>
                      </td>
                      <td className="muted small nowrap">
                        {file.source === "modrinth" ? "Modrinth" : "свой файл"}
                        {file.meta?.versionNumber ? ` · ${file.meta.versionNumber}` : ""}
                      </td>
                      <td className="muted small nowrap">{formatBytes(file.size)}</td>
                      <td className="nowrap">
                        <label className="inline-check" title="Ставится один раз, игрок может удалить">
                          <input
                            type="checkbox"
                            checked={file.optional}
                            onChange={(event) => toggleOptional(file.id, event.target.checked)}
                          />
                          необяз.
                        </label>
                      </td>
                      <td>
                        <button className="link danger" onClick={() => remove(file.id)}>
                          удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {dialogType && (
        <ModrinthDialog
          modeId={mode.id}
          minecraft={mode.minecraft}
          loader={mode.loaderType}
          type={dialogType}
          onClose={() => setDialogType(null)}
          onAdded={onReload}
        />
      )}
    </div>
  );
}
