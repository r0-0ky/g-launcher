#!/usr/bin/env bash
# Собирает мод Gandoni Quick Join под конкретную версию Minecraft и кладёт
# готовый jar в src-tauri/resources/quickjoin/, откуда лаунчер подкидывает его
# в сборки этой версии.
#
# Использование:
#   tools/build-mod.sh 1.20.1 1.20.1+build.10 0.92.2+1.20.1 [loader]
#   tools/build-mod.sh 1.21.1 1.21.1+build.3  0.102.0+1.21.1
#
# Аргументы: <mc_version> <yarn_mappings> <fabric_api> [loader_version]
# Требуется JDK 17–21 (переменная JAVA_HOME) и интернет для Fabric Loom.
#
# ВНИМАНИЕ: если путь к проекту содержит эмодзи/не-ASCII, Gradle падает на
# setcwd(). Скрипт сам собирает во временной ASCII-папке и копирует jar обратно.
set -euo pipefail

MC="${1:?нужна версия Minecraft, напр. 1.20.1}"
YARN="${2:?нужны yarn-маппинги, напр. 1.20.1+build.10}"
FABRIC_API="${3:?нужна версия Fabric API, напр. 0.92.2+1.20.1}"
LOADER="${4:-0.16.9}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOD_SRC="$ROOT/mod"
OUT_DIR="$ROOT/src-tauri/resources/quickjoin"
mkdir -p "$OUT_DIR"

# Собираем во временной папке без не-ASCII символов в пути.
WORK="$(mktemp -d /tmp/gandoni-mod.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$MOD_SRC/." "$WORK/"
rm -rf "$WORK/build" "$WORK/.gradle"

GRADLE="${GRADLE:-gradle}"
echo "Сборка мода под Minecraft $MC (yarn $YARN, fabric-api $FABRIC_API)…"
( cd "$WORK" && "$GRADLE" build --no-daemon --console=plain \
    -Pminecraft_version="$MC" \
    -Pyarn_mappings="$YARN" \
    -Pfabric_version="$FABRIC_API" \
    -Ploader_version="$LOADER" )

JAR="$(ls "$WORK"/build/libs/gandoni-quickjoin-*.jar | grep -v sources | head -1)"
DEST="$OUT_DIR/gandoni-quickjoin-$MC.jar"
cp "$JAR" "$DEST"
echo "Готово: $DEST"
