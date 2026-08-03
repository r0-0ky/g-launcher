#!/usr/bin/env node
// Меняет версию сразу в package.json и Cargo.toml — tauri.conf.json читает
// её из package.json, так что трогать его не нужно.
//
//   node tools/bump-version.mjs 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Укажите версию вида 0.2.0: node tools/bump-version.mjs 0.2.0");
  process.exit(1);
}

const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// В Cargo.toml правим только version в секции [package] — версии зависимостей ниже.
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const patched = cargo.replace(
  /(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
  `$1${version}$2`
);
if (patched === cargo) {
  console.error("Не нашёл version в [package] у src-tauri/Cargo.toml — поправьте вручную");
  process.exit(1);
}
writeFileSync(cargoPath, patched);

console.log(`Версия: ${previous} → ${version}`);
console.log("Дальше:");
console.log("  git commit -am \"версия " + version + "\"");
console.log(`  git tag v${version} && git push origin main --tags`);
