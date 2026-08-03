import type { Account, Mode } from "../api";
import { loaderLabel } from "../api";
import logo from "../assets/logo.jpg";

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
}: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={logo} alt="Gandoni" draggable={false} />
        <div className="brand-titles">
          <div className="brand-title">Gandoni</div>
          <div className="brand-sub">лаунчер</div>
        </div>
      </div>

      <div className="sidebar-head">
        <span>Режимы</span>
        <button className="icon-button" onClick={onRefresh} disabled={refreshing} title="Обновить список">
          {refreshing ? "…" : "⟳"}
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
          <div className="avatar">
            {account ? account.username.slice(0, 1).toUpperCase() : "?"}
          </div>
          <div className="account-text">
            <div className="account-name">{account ? account.username : "Нет аккаунта"}</div>
            <div className="account-kind">
              {account ? (account.kind === "microsoft" ? "Microsoft" : "Оффлайн") : "Нажмите, чтобы войти"}
            </div>
          </div>
        </button>
        <button className="icon-button" onClick={onSettingsClick} title="Настройки">
          ⚙
        </button>
      </div>
    </aside>
  );
}
