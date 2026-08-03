// Рисует исходный PNG для иконки лаунчера без внешних зависимостей.
// Морская звезда в стиле Бикини-Боттом на бирюзовом фоне.
// Запуск: node tools/make-icon.mjs  ->  src-tauri/icon-source.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "src-tauri", "icon-source.png");

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function roundedCoverage(x, y, size, radius) {
  const inset = size * 0.05;
  const min = inset;
  const max = size - inset;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const distance = Math.hypot(x - cx, y - cy);
  if (x < min || x > max || y < min || y > max) return 0;
  return Math.min(Math.max(radius + 0.5 - distance, 0), 1);
}

// Дистанция до 5-конечной звезды (приближение через угловой радиус).
function starValue(x, y, cx, cy, outer, inner) {
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  let angle = Math.atan2(dy, dx) + Math.PI / 2; // вершина вверх
  const sector = (Math.PI * 2) / 5;
  let a = ((angle % sector) + sector) % sector;
  a = Math.abs(a - sector / 2);
  const t = a / (sector / 2); // 0 — вершина, 1 — впадина
  const radius = outer - (outer - inner) * t;
  return dist - radius; // <0 внутри звезды
}

const pixels = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;

const cx = SIZE / 2;
const cy = SIZE * 0.52;
const outer = SIZE * 0.4;
const inner = SIZE * 0.18;

for (let y = 0; y < SIZE; y++) {
  pixels[offset++] = 0;
  for (let x = 0; x < SIZE; x++) {
    // Бирюзовая вода с высветлением сверху
    const depth = y / SIZE;
    let r = Math.round(70 - depth * 40);
    let g = Math.round(200 - depth * 60);
    let b = Math.round(225 - depth * 45);

    const s = starValue(x, y, cx, cy, outer, inner);
    if (s < 0) {
      // Тело звезды — розовое
      r = 239;
      g = 143;
      b = 184;
      // Тёмный контур
      if (s > -SIZE * 0.03) {
        r = 184;
        g = 86;
        b = 127;
      }
      // Пара глаз
      const eyeL = Math.hypot(x - (cx - SIZE * 0.09), y - (cy - SIZE * 0.05));
      const eyeR = Math.hypot(x - (cx + SIZE * 0.09), y - (cy - SIZE * 0.04));
      if (eyeL < SIZE * 0.055 || eyeR < SIZE * 0.055) {
        r = 255;
        g = 255;
        b = 255;
      }
      if (eyeL < SIZE * 0.02 || eyeR < SIZE * 0.02) {
        r = 26;
        g = 47;
        b = 61;
      }
    }

    const alpha = Math.round(255 * roundedCoverage(x, y, SIZE, SIZE * 0.22));
    pixels[offset++] = r;
    pixels[offset++] = g;
    pixels[offset++] = b;
    pixels[offset++] = alpha;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(pixels, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Готово: ${out} (${SIZE}x${SIZE})`);
