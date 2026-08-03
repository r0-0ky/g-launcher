#!/usr/bin/env node
// Собирает manifest.json из папки со сборками.
//
// Ожидаемая раскладка исходников:
//   modes/
//     survival/
//       mode.json        — метаданные режима (без files)
//       files/           — то, что должно оказаться в папке игры
//         mods/*.jar
//         config/**
//
// Пример:
//   node tools/build-manifest.mjs --src ./modes --base https://cdn.example.com/modes --out ./manifest.json

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function parseArgs(argv) {
  const args = { src: "./modes", base: "", out: "./manifest.json" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined && key in args) args[key] = value;
  }
  return args;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (info.isFile() && entry !== ".DS_Store") out.push(full);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const srcRoot = resolve(args.src);
const base = args.base.replace(/\/+$/, "");

if (!base) {
  console.error("Укажите --base: публичный URL, по которому лежат файлы сборок.");
  process.exit(1);
}
if (!existsSync(srcRoot)) {
  console.error(`Папка со сборками не найдена: ${srcRoot}`);
  process.exit(1);
}

const modes = [];

for (const entry of readdirSync(srcRoot)) {
  const modeDir = join(srcRoot, entry);
  if (!statSync(modeDir).isDirectory()) continue;

  const metaPath = join(modeDir, "mode.json");
  if (!existsSync(metaPath)) {
    console.warn(`Пропускаю ${entry}: нет mode.json`);
    continue;
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const filesDir = join(modeDir, "files");
  const files = [];

  if (existsSync(filesDir)) {
    for (const absolute of walk(filesDir)) {
      const rel = relative(filesDir, absolute).split(sep).join("/");
      const data = readFileSync(absolute);
      files.push({
        path: rel,
        url: `${base}/${meta.id ?? entry}/files/${rel.split("/").map(encodeURIComponent).join("/")}`,
        sha1: createHash("sha1").update(data).digest("hex"),
        size: data.length,
        ...(meta.optionalPaths?.includes(rel) ? { optional: true } : {}),
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  delete meta.optionalPaths;
  modes.push({ id: entry, ...meta, files });
  console.log(`${meta.name ?? entry}: ${files.length} файл(ов)`);
}

const manifest = {
  schema: 1,
  updated: new Date().toISOString(),
  modes,
};

writeFileSync(resolve(args.out), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nМанифест сохранён: ${resolve(args.out)}`);
