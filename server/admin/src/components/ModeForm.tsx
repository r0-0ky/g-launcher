import { useEffect, useState } from "react";
import type { LoaderKind, Mode } from "../api";
import { api, errorText } from "../api";

const LOADERS: Array<{ value: LoaderKind; label: string }> = [
  { value: "vanilla", label: "Ванилла (без модов)" },
  { value: "fabric", label: "Fabric" },
  { value: "quilt", label: "Quilt" },
  { value: "forge", label: "Forge" },
  { value: "neoforge", label: "NeoForge" },
];

interface Props {
  mode: Mode;
  onChange: (mode: Mode) => void;
}

/** Вкладка «Основное»: версия игры, лоадер, память, сервер. */
export function ModeForm({ mode, onChange }: Props) {
  const [mcVersions, setMcVersions] = useState<Array<{ id: string; type: string }>>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [loaderList, setLoaderList] = useState<string[]>([]);
  const [loaderError, setLoaderError] = useState<string | null>(null);

  useEffect(() => {
    api.minecraftVersions().then(setMcVersions).catch(() => setMcVersions([]));
  }, []);

  // Версии лоадера зависят от версии игры — перезапрашиваем при любой смене.
  useEffect(() => {
    if (mode.loaderType === "vanilla" || !mode.minecraft) {
      setLoaderList([]);
      return;
    }
    let cancelled = false;
    setLoaderError(null);
    api
      .loaderVersions(mode.loaderType, mode.minecraft)
      .then((list) => {
        if (cancelled) return;
        setLoaderList(list);
        if (list.length === 0) setLoaderError("Под эту версию сборок лоадера не нашлось");
      })
      .catch((err) => !cancelled && setLoaderError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [mode.loaderType, mode.minecraft]);

  const patch = (values: Partial<Mode>) => onChange({ ...mode, ...values });
  const visibleVersions = mcVersions.filter(
    (version) => showSnapshots || version.type === "release"
  );

  return (
    <div className="form-grid">
      <label className="field">
        <span>Название</span>
        <input value={mode.name} onChange={(event) => patch({ name: event.target.value })} />
      </label>

      <label className="field">
        <span>Версия сборки</span>
        <input
          value={mode.version ?? ""}
          placeholder="1.4.0"
          onChange={(event) => patch({ version: event.target.value || null })}
        />
      </label>

      <label className="field wide">
        <span>Описание</span>
        <textarea
          rows={3}
          value={mode.description}
          onChange={(event) => patch({ description: event.target.value })}
        />
      </label>

      <label className="field">
        <span>Версия Minecraft</span>
        <input
          list="mc-versions"
          value={mode.minecraft}
          onChange={(event) => patch({ minecraft: event.target.value })}
        />
        <datalist id="mc-versions">
          {visibleVersions.map((version) => (
            <option key={version.id} value={version.id} />
          ))}
        </datalist>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={showSnapshots}
            onChange={(event) => setShowSnapshots(event.target.checked)}
          />
          показывать снапшоты
        </label>
      </label>

      <label className="field">
        <span>Модлоадер</span>
        <select
          value={mode.loaderType}
          onChange={(event) =>
            patch({ loaderType: event.target.value as LoaderKind, loaderVersion: null })
          }
        >
          {LOADERS.map((loader) => (
            <option key={loader.value} value={loader.value}>
              {loader.label}
            </option>
          ))}
        </select>
      </label>

      {mode.loaderType !== "vanilla" && (
        <label className="field">
          <span>Версия лоадера</span>
          <select
            value={mode.loaderVersion ?? ""}
            onChange={(event) => patch({ loaderVersion: event.target.value || null })}
          >
            <option value="">последняя доступная</option>
            {loaderList.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
          {loaderError && <small className="warn">{loaderError}</small>}
        </label>
      )}

      <label className="field">
        <span>Java (мажорная версия)</span>
        <input
          type="number"
          value={mode.javaMajor ?? ""}
          placeholder="авто"
          onChange={(event) =>
            patch({ javaMajor: event.target.value ? Number(event.target.value) : null })
          }
        />
      </label>

      <label className="field">
        <span>Память, МБ (мин / макс)</span>
        <div className="row">
          <input
            type="number"
            value={mode.memoryMin ?? ""}
            placeholder="1024"
            onChange={(event) =>
              patch({ memoryMin: event.target.value ? Number(event.target.value) : null })
            }
          />
          <input
            type="number"
            value={mode.memoryMax ?? ""}
            placeholder="4096"
            onChange={(event) =>
              patch({ memoryMax: event.target.value ? Number(event.target.value) : null })
            }
          />
        </div>
      </label>

      <label className="field">
        <span>Сервер (host / port)</span>
        <div className="row">
          <input
            value={mode.serverHost ?? ""}
            placeholder="mc.example.com"
            onChange={(event) => patch({ serverHost: event.target.value || null })}
          />
          <input
            type="number"
            className="port"
            value={mode.serverPort ?? ""}
            placeholder="25565"
            onChange={(event) =>
              patch({ serverPort: event.target.value ? Number(event.target.value) : null })
            }
          />
        </div>
      </label>

      <label className="field">
        <span>Иконка (URL)</span>
        <input
          value={mode.icon ?? ""}
          onChange={(event) => patch({ icon: event.target.value || null })}
        />
      </label>

      <label className="field">
        <span>Баннер (URL)</span>
        <input
          value={mode.banner ?? ""}
          onChange={(event) => patch({ banner: event.target.value || null })}
        />
      </label>

      <label className="field wide">
        <span>Дополнительные аргументы JVM</span>
        <input
          value={mode.jvmArgs ?? ""}
          placeholder="-XX:+UseZGC"
          onChange={(event) => patch({ jvmArgs: event.target.value || null })}
        />
      </label>

      <label className="field">
        <span>Папки под контролем лаунчера</span>
        <input
          value={mode.syncPaths.join(", ")}
          onChange={(event) =>
            patch({
              syncPaths: event.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
        <small>Лишние файлы в них удаляются при обновлении</small>
      </label>

      <label className="field">
        <span>Не удалять (можно с *)</span>
        <input
          value={mode.keep.join(", ")}
          placeholder="config/keybinds.txt, options.txt"
          onChange={(event) =>
            patch({
              keep: event.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
    </div>
  );
}
