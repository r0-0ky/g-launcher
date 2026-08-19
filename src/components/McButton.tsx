import type { ButtonHTMLAttributes, FC, ReactNode } from "react";
import { Button as Raw } from "minecraft-react-ui";

/**
 * Кнопка из minecraft-react-ui (MIT), версия 0.6.0 — в 0.7.0 автор выложил
 * пустой пакет, без папки build.
 *
 * Типы там собраны под `@types/react` 17: в них `onPointerEnterCapture` и
 * `onPointerLeaveCapture` попали в обязательные, и с нашими типами React 18
 * компонент не подставляется в JSX. Приводим тип один раз здесь, чтобы в
 * остальном коде обходиться без приведений.
 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "clear";
  /** Нарисовать кнопку вдавленной, будто её держат нажатой. */
  active?: boolean;
  children?: ReactNode;
};

export const Button = Raw as unknown as FC<ButtonProps>;
