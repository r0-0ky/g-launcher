import { useEffect, useState } from "react";
import type { ProjectType, SearchHit, VersionFile } from "../api";
import { api, errorText, formatBytes } from "../api";

interface Props {
  modeId: string;
  minecraft: string;
  loader: string;
  type: ProjectType;
  onClose: () => void;
  onAdded: () => void;
}

const TYPE_TITLES: Record<ProjectType, string> = {
  mod: "Моды",
  shader: "Шейдеры",
  resourcepack: "Ресурс-паки",
};

/** Поиск по каталогу Modrinth с фильтром под версию и лоадер сборки. */
export function ModrinthDialog({ modeId, minecraft, loader, type, onClose, onAdded }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withDependencies, setWithDependencies] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionFile[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  // Поиск с задержкой, чтобы не долбить API на каждую букву.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .searchModrinth({ q: query, type, minecraft, loader })
        .then((result) => !cancelled && setHits(result))
        .catch((err) => !cancelled && setError(errorText(err)))
        .finally(() => !cancelled && setLoading(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, type, minecraft, loader]);

  async function toggleVersions(projectId: string) {
    if (expanded === projectId) {
      setExpanded(null);
      return;
    }
    setExpanded(projectId);
    setVersions([]);
    try {
      setVersions(await api.modrinthVersions({ projectId, type, minecraft, loader }));
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function add(projectId: string, versionId?: string) {
    setAdding(projectId);
    setError(null);
    try {
      const result = await api.addFromModrinth(modeId, {
        projectId,
        versionId,
        type,
        withDependencies,
      });
      setAdded((prev) => [...prev, projectId]);
      onAdded();
      if (result.added.length > 1) {
        setError(`Добавлено вместе с зависимостями: ${result.added.join(", ")}`);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal large" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{TYPE_TITLES[type]} из Modrinth</h2>
          <span className="muted">
            фильтр: {minecraft}
            {type === "mod" && loader !== "vanilla" ? ` · ${loader}` : ""}
          </span>
        </div>

        <input
          autoFocus
          placeholder="Название мода…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {error && <div className="error">{error}</div>}

        <div className="search-results">
          {loading && <div className="muted">Ищем…</div>}
          {!loading && hits.length === 0 && (
            <div className="muted">Ничего не нашлось под эти параметры</div>
          )}
          {hits.map((hit) => (
            <div key={hit.projectId} className="search-row">
              <div className="search-main">
                {hit.iconUrl ? (
                  <img src={hit.iconUrl} alt="" className="project-icon" />
                ) : (
                  <div className="project-icon placeholder">{hit.title.slice(0, 1)}</div>
                )}
                <div className="search-text">
                  <div className="search-title">
                    {hit.title}
                    <span className="muted small"> · {hit.downloads.toLocaleString("ru")} загр.</span>
                  </div>
                  <div className="muted small">{hit.description}</div>
                </div>
                <div className="search-actions">
                  <button className="ghost" onClick={() => toggleVersions(hit.projectId)}>
                    версии
                  </button>
                  <button
                    className="primary small"
                    disabled={adding === hit.projectId}
                    onClick={() => add(hit.projectId)}
                  >
                    {added.includes(hit.projectId)
                      ? "добавлено ✓"
                      : adding === hit.projectId
                        ? "…"
                        : "добавить"}
                  </button>
                </div>
              </div>

              {expanded === hit.projectId && (
                <div className="version-list">
                  {versions.length === 0 && <div className="muted small">Загружаем версии…</div>}
                  {versions.slice(0, 12).map((version) => (
                    <button
                      key={version.versionId}
                      className="version-row"
                      onClick={() => add(hit.projectId, version.versionId)}
                    >
                      <span>{version.versionNumber}</span>
                      <span className="muted small">
                        {version.filename} · {formatBytes(version.size)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={withDependencies}
              onChange={(event) => setWithDependencies(event.target.checked)}
            />
            добавлять обязательные зависимости
          </label>
          <div className="spacer" />
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
