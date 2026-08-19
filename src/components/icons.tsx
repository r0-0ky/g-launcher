/**
 * Пиксельные иконки из pixelarticons (MIT, Gerrit Halfmann):
 * https://github.com/halfmage/pixelarticons
 *
 * Взяты только нужные — тащить пакет ради десятка картинок незачем. Сетка
 * 24×24, `crispEdges` не даёт браузеру сглаживать края.
 */

interface Props {
  size?: number;
  className?: string;
}

function icon(paths: string[]) {
  return function Icon({ size = 18, className }: Props) {
    return (
      <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        shapeRendering="crispEdges"
        aria-hidden
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  };
}

export const VolumeOn = icon([
  "M11 22H9v-2H7v-2h2V6H7V4h2V2h2v20Zm8 0h-6v-2h6v2Zm2-2h-2v-2h2v2ZM7 18H5v-2h2v2Zm10 0h-4v-2h4v2Zm6 0h-2V6h2v12ZM5 10H3v4h2v2H1V8h4v2Zm14 6h-2V8h2v8Zm-4-2h-2v-4h2v4ZM7 8H5V6h2v2Zm10 0h-4V6h4v2Zm4-2h-2V4h2v2Zm-2-2h-6V2h6v2Z",
]);

export const VolumeOff = icon([
  "M13 22h-2v-2H9v-2h2V6H9V4h2V2h2v20Zm-4-4H7v-2h2v2Zm-2-8H5v4h2v2H3V8h4v2Zm10.001 5.224h-2v-2H17v-2h-1.999v-2h2v2H19v2h-1.999v2Zm3.999 0h-2v-2h2v2Zm0-4h-2v-2h2v2ZM9 8H7V6h2v2Z",
]);

export const Reload = icon([
  "M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z",
  "M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z",
  "M20 18H4v-2h16z",
]);

export const Settings = icon([
  "M4 20h3v-2h4v4h2v-4h4v2h-2v4H9v-4H7v2H2v-5h2v3Zm18 2h-5v-2h3v-3h2v5ZM6 11H2v2h4v4H4v-2H0V9h4V7h2v4Zm14-2h4v6h-4v2h-2v-4h4v-2h-4V7h2v2Zm-6 7h-4v-2h4v2Zm-4-2H8v-4h2v4Zm6 0h-2v-4h2v4Zm-2-4h-4V8h4v2ZM7 4H4v3H2V2h5v2Zm8 0h2V2h5v5h-2V4h-3v2h-4V2h-2v4H7V4h2V0h6v4Z",
]);

export const Close = icon([
  "M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z",
]);

export const Alert = icon([
  "M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z",
]);

export const Play = icon([
  "M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z",
]);

export const Trash = icon([
  "M18 22H6V20H18V22ZM9 6H15V4H17V6H22V8H20V20H18V8H6V20H4V8H2V6H7V4H9V6ZM15 4H9V2H15V4Z",
]);

export const Folder = icon([
  "M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z",
]);

export const Check = icon([
  "M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z",
]);

export const Logout = icon([
  "M8 11h12v2H8zm8-2h2v2h-2z",
  "M14 7h2v10h-2zm2 6h2v2h-2zM6 2h12v2H6zm0 18h12v2H6zM4 4h2v16H4zm14 0h2v3h-2zm0 13h2v3h-2z",
]);

/** Пустая ячейка: коробка с крестом — «ничего не надето». */
export const NoTexture = icon([
  "M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2z",
  "M7 7h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z",
  "M7 15h2v2H7zm2-2h2v2H9zm4 0h2v2h-2zm2 2h2v2h-2z",
]);

export const User = icon([
  "M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm14 0h2v4h-2zM8 14h8v2H8zm-2 2h2v2H6zm10 0h2v2h-2z",
]);
