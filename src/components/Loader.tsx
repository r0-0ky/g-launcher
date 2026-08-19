import { Reload } from "./icons";

/** Крутящийся значок на время загрузки — тот же, что и у кнопки обновления. */
interface Props {
  label?: string;
}

export function Loader({ label = "Загружаем…" }: Props) {
  return (
    <div className="loader">
      <Reload size={28} />
      <span className="muted">{label}</span>
    </div>
  );
}
