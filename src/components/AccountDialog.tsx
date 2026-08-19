import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Account, Bootstrap, DeviceCode } from "../api";
import { api, errorText } from "../api";
import { Button } from "./McButton";

interface Props {
  accounts: Account[];
  activeId: string | null;
  onClose: () => void;
  onChanged: (bootstrap: Bootstrap) => void;
}

export function AccountDialog({ accounts, activeId, onClose, onChanged }: Props) {
  // Аккаунт G Land без ника: играть с таким нельзя, поэтому просим выбрать.
  const needsNickname = accounts.some(
    (account) => account.id === activeId && account.kind === "gland" && !account.username
  );

  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [glandWaiting, setGlandWaiting] = useState(false);
  const [glandNick, setGlandNick] = useState("");
  const [waiting, setWaiting] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Опрос Microsoft живёт только пока открыт диалог.
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  async function addOffline() {
    setError(null);
    try {
      onChanged(await api.addOfflineAccount(nickname));
      setNickname("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function startMicrosoft() {
    setError(null);
    try {
      const code = await api.msLoginStart();
      setDevice(code);
      setWaiting(true);
      await openUrl(code.verificationUri);

      pollRef.current = window.setInterval(async () => {
        try {
          const result = await api.msLoginPoll(code.deviceCode);
          if (result) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setWaiting(false);
            setDevice(null);
            onChanged(result);
          }
        } catch (err) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setWaiting(false);
          setDevice(null);
          setError(errorText(err));
        }
      }, Math.max(code.interval, 2) * 1000);
    } catch (err) {
      setError(errorText(err));
    }
  }

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

  async function select(id: string) {
    onChanged(await api.setActiveAccount(id));
  }

  async function remove(id: string) {
    onChanged(await api.removeAccount(id));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Аккаунты</h2>

        <div className="account-list">
          {accounts.length === 0 && <div className="muted">Пока нет ни одного аккаунта</div>}
          {accounts.map((account) => (
            <div
              key={account.id}
              className={`account-row${account.id === activeId ? " active" : ""}`}
            >
              <button className="account-select" onClick={() => select(account.id)}>
                <div className="avatar small">{account.username.slice(0, 1).toUpperCase()}</div>
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
              <Button variant="clear" className="danger" onClick={() => remove(account.id)}>
                Удалить
              </Button>
            </div>
          ))}
        </div>

        <div className="divider" />

        <label className="field">
          <span>Оффлайн-аккаунт</span>
          <div className="row">
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Ник в игре"
              maxLength={16}
            />
            <Button variant="primary" onClick={addOffline} disabled={!nickname.trim()}>
              Добавить
            </Button>
          </div>
        </label>

        <div className="field">
          <span>Аккаунт G Land</span>
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

        <div className="field">
          <span>Лицензия Microsoft</span>
          {device ? (
            <div className="device-code">
              <div>
                Откройте <b>{device.verificationUri}</b> и введите код:
              </div>
              <div className="code">{device.userCode}</div>
              <div className="muted">{waiting ? "Ждём подтверждения…" : ""}</div>
            </div>
          ) : (
            <Button variant="secondary" onClick={startMicrosoft}>
              Войти через Microsoft
            </Button>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <div className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </div>
    </div>
  );
}
