// Готовит исходник иконки под гайдлайн Apple: картинка вписывается в тело 824×824
// на прозрачном холсте 1024×1024 со скруглёнными углами и полями по краям —
// так иконка выглядит скруглённой в доке macOS.
//
// Запуск: node tools/round-icon.mjs <входная-картинка> [выход.png]
// По умолчанию выход — src-tauri/icon-source.png. Затем: npx tauri icon <выход>
import { deflateSync, inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANVAS = 1024;
const BODY = 824; // тело иконки по шаблону Apple (по 100px поля с каждой стороны)
const MARGIN = (CANVAS - BODY) / 2;
const RADIUS = 185.4; // радиус скругления Apple для 1024-холста

const here = dirname(fileURLToPath(import.meta.url));
const input = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? join(here, "..", "src-tauri", "icon-source.png"));
if (!input) {
  console.error("Укажи путь к входной картинке");
  process.exit(1);
}

// 1. Приводим вход к телу иконки (BODY×BODY, PNG) через sips.
const work = mkdtempSync(join(tmpdir(), "icon-"));
const resized = join(work, "body.png");
execFileSync("sips", ["-s", "format", "png", "-z", String(BODY), String(BODY), input, "--out", resized]);

// --- Минимальные PNG-декодер и энкодер (8 бит, без чересстрочности) ---

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buffer) {
  let offset = 8; // пропускаем сигнатуру
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const recon = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let i = 0; i < stride; i++) {
      const value = raw[pos++];
      const a = i >= channels ? recon[y * stride + i - channels] : 0;
      const b = y > 0 ? recon[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? recon[(y - 1) * stride + i - channels] : 0;
      let out = value;
      if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      recon[y * stride + i] = out & 0xff;
    }
  }
  return { width, height, channels, data: recon };
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // фильтр строки: none
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Покрытие скруглённого прямоугольника (SDF) со сглаживанием краёв.
function roundedCoverage(x, y) {
  const cx = CANVAS / 2;
  const half = BODY / 2;
  const qx = Math.abs(x - cx) - (half - RADIUS);
  const qy = Math.abs(y - cx) - (half - RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const dist = outside + inside - RADIUS; // <0 внутри
  return Math.min(Math.max(0.5 - dist, 0), 1);
}

// 2. Собираем холст 1024 с телом по центру и скруглением.
const body = decodePng(readFileSync(resized));
const out = Buffer.alloc(CANVAS * CANVAS * 4); // прозрачный по умолчанию

for (let y = 0; y < CANVAS; y++) {
  for (let x = 0; x < CANVAS; x++) {
    const coverage = roundedCoverage(x + 0.5, y + 0.5);
    if (coverage <= 0) continue;

    const bx = x - MARGIN;
    const by = y - MARGIN;
    if (bx < 0 || by < 0 || bx >= body.width || by >= body.height) continue;

    const src = (by * body.width + bx) * body.channels;
    const dst = (y * CANVAS + x) * 4;
    out[dst] = body.data[src];
    out[dst + 1] = body.data[src + 1];
    out[dst + 2] = body.data[src + 2];
    const srcAlpha = body.channels === 4 ? body.data[src + 3] : 255;
    out[dst + 3] = Math.round(srcAlpha * coverage);
  }
}

writeFileSync(output, encodePng(CANVAS, CANVAS, out));
console.log(`Готово: ${output} (${CANVAS}×${CANVAS}, скруглённая)`);
