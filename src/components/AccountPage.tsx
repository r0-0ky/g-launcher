import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Account, Bootstrap, Library } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";
import { Close, Logout, NoTexture } from "./icons";
import { SkinPreview } from "./SkinPreview";

interface Props {
  accounts: Account[];
  activeId: string | null;
  onClose: () => void;
  onChanged: (bootstrap: Bootstrap) => void;
}

export function AccountPage({ accounts, activeId, onClose, onChanged }: Props) {
  // Вошёл — кнопку входа не показываем. Чтобы войти заново (например, если
  // сессия протухла), аккаунт достаточно удалить из списка.
  const signedIn = accounts.some((account) => account.kind === "gland");

  // Аккаунт G Land без ника: играть с таким нельзя, поэтому просим выбрать.
  const needsNickname = accounts.some(
    (account) => account.id === activeId && account.kind === "gland" && !account.username
  );

  const [error, setError] = useState<string | null>(null);
  const [glandWaiting, setGlandWaiting] = useState(false);
  const [glandNick, setGlandNick] = useState("");
  const [library, setLibrary] = useState<Library | null>(null);
  const activeSkin = library?.skins.find((texture) => texture.active) ?? null;
  const activeCape = library?.capes.find((texture) => texture.active) ?? null;
  const [model, setModel] = useState<"classic" | "slim">("classic");
  const pollRef = useRef<number | null>(null);

  // Библиотека текстур подтягивается, когда есть куда: без входа её нет.
  useEffect(() => {
    if (!signedIn) {
      setLibrary(null);
      return;
    }
    api.glandTextures().then(applyLibrary).catch((err) => setError(errorText(err)));
  }, [signedIn]);

  // Опрос входа живёт только пока открыт диалог.
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  /** Вход через Telegram: открываем бота и ждём нажатия кнопки. */
  async function startGLand() {
    setError(null);
    try {
      const login = await api.glandLoginStart();
      setGlandWaiting(true);
      await openUrl(login.url);

      pollRef.current = window.setInterval(async () => {
        try {
          const result = await api.glandLoginPoll(login.token);
          if (!result) return;
          if (pollRef.current) window.clearInterval(pollRef.current);
          setGlandWaiting(false);
          onChanged(result);
        } catch (err) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setGlandWaiting(false);
          setError(errorText(err));
        }
      }, 2000);
    } catch (err) {
      setGlandWaiting(false);
      setError(errorText(err));
    }
  }

  async function saveGLandNick() {
    setError(null);
    try {
      onChanged(await api.glandSetNickname(glandNick));
      setGlandNick("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  /**
   * Библиотека и переключатель рук всегда обновляются вместе: у каждого скина
   * своя модель, и при выборе другого положение переключателя должно
   * измениться следом, иначе он показывает руки прошлого скина.
   */
  function applyLibrary(next: Library) {
    setLibrary(next);
    setModel(next.profile.skinModel);
  }

  /** Заливка: выбираем файл на диске, остальное делает сервер. */
  async function uploadTexture(kind: "skin" | "cape") {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Картинка PNG", extensions: ["png"] }],
      });
      if (typeof picked !== "string") return;
      applyLibrary(await api.glandUploadTexture(picked, kind, model));
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function textureAction(action: Promise<Library>) {
    setError(null);
    try {
      applyLibrary(await action);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function select(id: string) {
    onChanged(await api.setActiveAccount(id));
  }

  async function remove(id: string) {
    onChanged(await api.removeAccount(id));
  }

  return (
    <section className="account-page">
      <header className="account-head">
        <h2>Аккаунт</h2>
        <Button variant="secondary" onClick={onClose}>
          Назад
        </Button>
      </header>


      <div className="account-columns">
        <div className="account-main">

        <div className="account-list">
          {accounts.length === 0 && <div className="muted">Пока нет ни одного аккаунта</div>}
          {accounts.map((account) => (
            <div
              key={account.id}
              className={`account-row${account.id === activeId ? " active" : ""}`}
            >
              <button className="account-select" onClick={() => select(account.id)}>
                {account.avatar ? (
                  <img className="avatar small" src={account.avatar} alt="" draggable={false} />
                ) : (
                  <div className="avatar small">
                    {account.username.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="account-name">{account.username}</div>
                  <div className="account-kind">
                    {account.kind === "microsoft"
                      ? "Microsoft"
                      : account.kind === "gland"
                        ? "G Land"
                        : "Оффлайн"}
                  </div>
                </div>
              </button>
              <Button variant="secondary" onClick={() => remove(account.id)} title="Выйти из аккаунта">
                <Logout />
                Выйти
              </Button>
            </div>
          ))}
        </div>

        <div className="divider" />

        {!signedIn && (
          <div className="field">
            <span>Вход</span>
            {glandWaiting ? (
              <div className="device-code">
                <div>Подтвердите вход в Telegram — нажмите «Start» у бота.</div>
                <div className="muted">Ждём подтверждения…</div>
              </div>
            ) : (
              <Button variant="secondary" onClick={startGLand}>
                Войти через Telegram
              </Button>
            )}
          </div>
        )}

        {library && (
          <>
            <div className="field">
              <span>Скин</span>
              <div className="texture-grid">
                {/* Пустая ячейка: без своей текстуры игра сама подставит один
                    из стандартных скинов Mojang — они бесплатные для всех. */}
                <div className={`texture${library.profile.hasSkin ? "" : " active"}`}>
                  <button
                    className="texture-none"
                    title="Без скина — игра подставит стандартный"
                    onClick={() => textureAction(api.glandClearTexture("skin"))}
                  >
                    <NoTexture size={28} />
                  </button>
                </div>
                {library.skins.map((texture) => (
                  <div
                    key={texture.id}
                    className={`texture${texture.active ? " active" : ""}`}
                    title={texture.model === "slim" ? "Тонкие руки" : "Обычные руки"}
                  >
                    <button
                      className="texture-face"
                      style={{ backgroundImage: `url(${texture.url})` }}
                      onClick={() => textureAction(api.glandSelectTexture(texture.id))}
                    />
                    <button
                      className="texture-drop"
                      title="Убрать из библиотеки"
                      onClick={() => textureAction(api.glandDeleteTexture(texture.id))}
                    >
                      <Close size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="row">
                {library.profile.canUpload && (
                  <Button variant="secondary" onClick={() => uploadTexture("skin")}>
                    Загрузить скин
                  </Button>
                )}
                <label className="switch" title="Тонкие руки, как у модели Alex">
                  <input
                    type="checkbox"
                    checked={model === "slim"}
                    onChange={(event) => {
                      // Переключатель меняет руки у надетого скина сразу, а не
                      // только у того, который зальют следующим.
                      const next = event.target.checked ? "slim" : "classic";
                      setModel(next);
                      void textureAction(api.glandSetModel(next));
                    }}
                  />
                  <span className="switch-track">
                    <span className="switch-knob" />
                  </span>
                  <span>Тонкие руки</span>
                </label>
              </div>
              {library.profile.canUpload && (
                <small>Модель выбирается до загрузки: 64×64 или 64×32, не больше 200 КБ.</small>
              )}
            </div>

            <div className="field">
              <span>Плащ</span>
              <div className="texture-grid">
                <div className={`texture${library.profile.hasCape ? "" : " active"}`}>
                  <button
                    className="texture-none cape"
                    title="Без плаща"
                    onClick={() => textureAction(api.glandClearTexture("cape"))}
                  >
                    <NoTexture size={28} />
                  </button>
                </div>
                {library.capes.map((texture) => (
                  <div
                    key={texture.id}
                    className={`texture${texture.active ? " active" : ""}`}
                  >
                    <button
                      className="texture-cape"
                      style={{ backgroundImage: `url(${texture.url})` }}
                      onClick={() => textureAction(api.glandSelectTexture(texture.id))}
                    />
                    <button
                      className="texture-drop"
                      title="Убрать из библиотеки"
                      onClick={() => textureAction(api.glandDeleteTexture(texture.id))}
                    >
                      <Close size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="row">
                {library.profile.canUpload && (
                  <Button variant="secondary" onClick={() => uploadTexture("cape")}>
                    Загрузить плащ
                  </Button>
                )}
              </div>
              {library.profile.canUpload && (
                <small>Вдвое шире, чем выше: 64×32, 128×64, 256×128 или 512×256.</small>
              )}
            </div>
          </>
        )}

        {needsNickname && (
          <label className="field">
            <span>Выберите ник — его увидят на сервере</span>
            <div className="row">
              <input
                value={glandNick}
                onChange={(event) => setGlandNick(event.target.value)}
                placeholder="Ник в игре"
                maxLength={16}
              />
              <Button variant="primary" onClick={saveGLandNick} disabled={!glandNick.trim()}>
                Сохранить
              </Button>
            </div>
            <small>Менять можно когда угодно: прогресс на сервере привязан не к нику.</small>
          </label>
        )}

          {error && <div className="error">{error}</div>}
        </div>

        <aside className="account-side">
          {/* Ничего не надето — показываем тот же стандартный скин, который
              подставится в игре, а не пустую модель. */}
          <SkinPreview
            skin={activeSkin?.url ?? library?.profile.defaultSkin?.url ?? null}
            cape={activeCape?.url ?? null}
            model={activeSkin?.model ?? library?.profile.defaultSkin?.model ?? "classic"}
            width={260}
            height={380}
          />
          <div className="muted">Покрутите мышью</div>
        </aside>
      </div>
    </section>
  );
}
