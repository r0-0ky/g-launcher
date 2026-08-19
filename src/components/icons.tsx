/**
 * Пиксельные иконки из pixelarticons (MIT, Gerrit Halfmann):
 * https://github.com/halfmage/pixelarticons
 *
 * Взяты только нужные — тащить пакет ради двух картинок незачем. Сетка 24×24,
 * `crispEdges` не даёт браузеру сглаживать края.
 */

const base = {
  viewBox: "0 0 24 24",
  fill: "currentColor",
  shapeRendering: "crispEdges" as const,
  "aria-hidden": true,
};

export function VolumeOn({ size = 20 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M11 22H9v-2H7v-2h2V6H7V4h2V2h2v20Zm8 0h-6v-2h6v2Zm2-2h-2v-2h2v2ZM7 18H5v-2h2v2Zm10 0h-4v-2h4v2Zm6 0h-2V6h2v12ZM5 10H3v4h2v2H1V8h4v2Zm14 6h-2V8h2v8Zm-4-2h-2v-4h2v4ZM7 8H5V6h2v2Zm10 0h-4V6h4v2Zm4-2h-2V4h2v2Zm-2-2h-6V2h6v2Z" />
    </svg>
  );
}

export function VolumeOff({ size = 20 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M13 22h-2v-2H9v-2h2V6H9V4h2V2h2v20Zm-4-4H7v-2h2v2Zm-2-8H5v4h2v2H3V8h4v2Zm10.001 5.224h-2v-2H17v-2h-1.999v-2h2v2H19v2h-1.999v2Zm3.999 0h-2v-2h2v2Zm0-4h-2v-2h2v2ZM9 8H7V6h2v2Z" />
    </svg>
  );
}
