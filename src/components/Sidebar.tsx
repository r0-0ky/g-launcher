import type { Account, Mode } from "../api";
import { loaderLabel } from "../api";
import logo from "../assets/logo-gland.webp";
import { Reload, Settings, User, VolumeOff, VolumeOn } from "./icons";

interface Props {
  modes: Mode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  account: Account | null;
  onAccountClick: () => void;
  onSettingsClick: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  updatable: Record<string, boolean>;
  musicOff: boolean;
  onMusicToggle: () => void;
}

export function Sidebar({
  modes,
  selectedId,
  onSelect,
  account,
  onAccountClick,
  onSettingsClick,
  onRefresh,
  refreshing,
  updatable,
  musicOff,
  onMusicToggle,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={logo} alt="G LAND" draggable={false} />
      </div>

      <div className="sidebar-head">
        <span>Режимы</span>
        <button
          className={`icon-button${refreshing ? " spinning" : ""}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Обновить список"
        >
          <Reload />
        </button>
      </div>

      <nav className="mode-list">
        {modes.length === 0 && <div className="empty-hint">Список пуст</div>}
        {modes.map((mode) => (
          <button
            key={mode.id}
            className={`mode-item${mode.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(mode.id)}
          >
            {mode.icon ? (
              <img className="mode-icon" src={mode.icon} alt="" />
            ) : (
              <div className="mode-icon placeholder">{mode.name.slice(0, 1)}</div>
            )}
            <div className="mode-item-text">
              <div className="mode-item-name">{mode.name}</div>
              <div className="mode-item-meta">
                {mode.minecraft} · {loaderLabel(mode)}
              </div>
            </div>
            {updatable[mode.id] && <span className="update-dot" title="Есть обновление" />}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="account-button" onClick={onAccountClick}>
          {account?.avatar ? (
            <img className="avatar" src={account.avatar} alt="" draggable={false} />
          ) : (
            <div className="avatar">
              {account ? account.username.slice(0, 1).toUpperCase() : <User size={16} />}
            </div>
          )}
          <div className="account-name">{account ? account.username : "Нет аккаунта"}</div>
        </button>
        <button
          className="icon-button"
          onClick={onMusicToggle}
          title={musicOff ? "Включить музыку" : "Выключить музыку"}
        >
          {musicOff ? <VolumeOff /> : <VolumeOn />}
        </button>
        <button className="icon-button" onClick={onSettingsClick} title="Настройки">
          <Settings />
        </button>
      </div>
    </aside>
  );
}
