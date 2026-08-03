import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Account, Bootstrap, DeviceCode } from "../api";
import { api, errorText } from "../api";

interface Props {
  accounts: Account[];
  activeId: string | null;
  onClose: () => void;
  onChanged: (bootstrap: Bootstrap) => void;
}

export function AccountDialog({ accounts, activeId, onClose, onChanged }: Props) {
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
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
                    {account.kind === "microsoft" ? "Microsoft" : "Оффлайн"}
                  </div>
                </div>
              </button>
              <button className="link-button danger" onClick={() => remove(account.id)}>
                Удалить
              </button>
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
            <button className="play-button small" onClick={addOffline} disabled={!nickname.trim()}>
              Добавить
            </button>
          </div>
        </label>

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
            <button className="ghost-button" onClick={startMicrosoft}>
              Войти через Microsoft
            </button>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <div className="spacer" />
          <button className="ghost-button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
