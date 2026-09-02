import { Reload } from "./icons";

/** Крутящийся значок на время загрузки — тот же, что и у кнопки обновления. */
interface Props {
  /** `null` — только значок: подпись бывает лишней, когда текст стоит рядом. */
  label?: string | null;
}

export function Loader({ label = "Загружаем…" }: Props) {
  return (
    <div className="loader">
      <Reload size={28} />
      {label !== null && <span className="muted">{label}</span>}
    </div>
  );
}
