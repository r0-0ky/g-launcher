import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Кнопка в оформлении minecraft-react-ui: разметка наша, весь вид — их классы
 * из assets/minecraft-react-ui.css (MIT, José Manuel Piñeiro Garcia).
 *
 * Сам пакет не подключаем: 0.7.0 опубликован без папки build, а в 0.6.0 сборка
 * тянет tslib несуществующим путём внутрь node_modules и требует classnames с
 * prop-types, которых нет в её зависимостях. Vite-сборку это лечится алиасом,
 * а dev-сервер всё равно падает — он пребандлит зависимости через esbuild,
 * мимо алиасов. Проще держать эти десять строк у себя.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "clear";
  /** Нарисовать кнопку вдавленной, будто её держат нажатой. */
  active?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  active = false,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const classes = ["Button", "Button_" + variant];
  if (active) classes.push("Button_active");
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(" ")} {...rest}>
      {children}
    </button>
  );
}
