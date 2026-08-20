import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { MONOCRAFT_BASE64 } from "./fonts.js";

/** Первый кадр фона: показывается мгновенно, пока видео ещё качается. */
const POSTER = "download-poster.jpg";

/**
 * Статика титульного экрана лежит в репозитории и едет в образе (server/assets).
 * Путь считается от этого модуля, а не от рабочей папки: и в `dist/routes`,
 * и в `src/routes` до `assets` ровно два уровня вверх.
 */
const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

/** Метка версии файла: размера и времени правки достаточно. */
function tagOf(info: { size: number; mtimeMs: number }): string {
  return `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
}

/**
 * Файл с тем же именем в DATA_DIR перебивает вшитый — так фон можно заменить
 * на живом сервере, не пересобирая образ:
 *
 *   scp video.mp4 сервер:/srv/g-launcher/data/download-background.mp4
 *
 * Нет ни того, ни другого — страница останется с градиентом воды.
 */
function assetPath(name: string): string | null {
  const override = resolve(config.dataDir, name);
  if (existsSync(override)) return override;
  const bundled = resolve(assetsDir, name);
  return existsSync(bundled) ? bundled : null;
}

/**
 * Страница загрузки лаунчера. Данные берутся из последнего релиза на GitHub,
 * поэтому после выпуска новой версии здесь ничего менять не надо.
 */

interface Asset {
  name: string;
  url: string;
  size: number;
}

interface Release {
  version: string;
  publishedAt: string | null;
  /** Нужен странице, чтобы дать ссылку на список всех релизов. */
  repo: string;
  assets: { macos: Asset[]; windows: Asset[]; linux: Asset[] };
}

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; value: Release } | null = null;

/** Файлы обновлялки и подписи на странице не нужны — их качает сам лаунчер. */
function isInstaller(name: string): boolean {
  return !/\.(sig|tar\.gz|json)$/i.test(name);
}

function classify(name: string): keyof Release["assets"] | null {
  if (/\.(dmg|app\.zip)$/i.test(name)) return "macos";
  if (/\.(exe|msi)$/i.test(name)) return "windows";
  if (/\.(AppImage|deb|rpm)$/i.test(name)) return "linux";
  return null;
}

async function fetchLatest(): Promise<Release> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "gandoni-launcher-server",
  };
  // Необязательный токен поднимает лимит GitHub с 60 до 5000 запросов в час.
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;

  const response = await fetch(
    `https://api.github.com/repos/${config.githubRepo}/releases/latest`,
    { headers }
  );
  // 404 — это не поломка, а «релизов ещё не выпускали». Отдаём пустой список,
  // иначе страница ругается сбоем на совершенно нормальном состоянии.
  if (response.status === 404) {
    const empty: Release = {
      version: "",
      publishedAt: null,
      repo: config.githubRepo,
      assets: { macos: [], windows: [], linux: [] },
    };
    cache = { at: Date.now(), value: empty };
    return empty;
  }
  if (!response.ok) {
    throw new Error(`GitHub ответил ${response.status}`);
  }

  const data = (await response.json()) as {
    tag_name: string;
    published_at?: string;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  };

  const value: Release = {
    version: (data.tag_name ?? "").replace(/^v/, ""),
    publishedAt: data.published_at ?? null,
    repo: config.githubRepo,
    assets: { macos: [], windows: [], linux: [] },
  };

  for (const asset of data.assets ?? []) {
    if (!isInstaller(asset.name)) continue;
    const os = classify(asset.name);
    if (!os) continue;
    value.assets[os].push({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    });
  }

  cache = { at: Date.now(), value };
  return value;
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/download/release.json", async (_request, reply) => {
    if (!config.githubRepo) {
      return reply.code(503).send({ error: "GITHUB_REPO не задан в окружении сервера" });
    }
    try {
      reply.header("cache-control", "public, max-age=300");
      return await fetchLatest();
    } catch (error) {
      app.log.error(error);
      // Отдаём последнее удачное значение, если GitHub недоступен.
      if (cache) return cache.value;
      return reply.code(502).send({ error: "не удалось получить релиз с GitHub" });
    }
  });

  app.get("/download", async (_request, reply) => {
    reply.header("cache-control", "no-cache").type("text/html; charset=utf-8");
    return page;
  });

  // Шрифт страницы. Содержимое неизменно, поэтому кэш вечный.
  const fonts: Record<string, string> = {
    "monocraft.woff2": MONOCRAFT_BASE64,
  };

  // Стили кнопок из minecraft-react-ui: страница не React-приложение,
  // поэтому берёт их классы напрямую (файл лежит в assets, MIT).
  app.get("/download/minecraft-react-ui.css", async (request, reply) => {
    const file = assetPath("minecraft-react-ui.css");
    if (!file) return reply.code(404).send({ error: "не найдено" });

    const info = statSync(file);
    const etag = tagOf(info);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();

    return reply
      .header("etag", etag)
      .header("cache-control", "public, max-age=86400")
      .type("text/css; charset=utf-8")
      .send(createReadStream(file));
  });

  app.get<{ Params: { name: string } }>("/download/:name(bubble|favicon|favicon-180).png", async (request, reply) => {
    const file = assetPath(request.params.name + ".png");
    if (!file) return reply.code(404).send({ error: "не найдено" });

    const info = statSync(file);
    const etag = tagOf(info);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();

    return reply
      .header("etag", etag)
      .header("cache-control", "public, max-age=86400")
      .header("content-length", info.size)
      .type("image/png")
      .send(createReadStream(file));
  });

  app.get("/download/logo.webp", async (request, reply) => {
    const file = assetPath("logo.webp");
    if (!file) return reply.code(404).send({ error: "не найдено" });

    const info = statSync(file);
    const etag = tagOf(info);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();

    return reply
      .header("etag", etag)
      .header("cache-control", "public, max-age=86400")
      .header("content-length", info.size)
      .type("image/webp")
      .send(createReadStream(file));
  });

  app.get<{ Params: { name: string } }>(
    "/download/:name(poster|secret-bg).jpg",
    async (request, reply) => {
    const file = assetPath(
      request.params.name === "poster" ? POSTER : "secret-bg.jpg"
    );
    if (!file) return reply.code(404).send({ error: "не найдено" });

    const info = statSync(file);
    const etag = tagOf(info);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();

    return reply
      .header("etag", etag)
      .header("cache-control", "public, max-age=86400")
      .header("content-length", info.size)
      .type("image/jpeg")
      .send(createReadStream(file));
    }
  );

  /** Отдаёт файл кусками: без этого Safari не проигрывает ни видео, ни звук. */
  async function sendRanged(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    type: string
  ) {
    const file = assetPath(name);
    if (!file) return reply.code(404).send({ error: "не найдено" });

    const info = statSync(file);
    const etag = tagOf(info);
    // Файл меняется только с деплоем, поэтому кэш на сутки, а свежесть
    // проверяется дешёвым запросом с ETag.
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();

    reply
      .header("accept-ranges", "bytes")
      .header("etag", etag)
      .header("cache-control", "public, max-age=86400")
      .type(type);

    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start >= info.size || start > end) {
        return reply
          .code(416)
          .header("content-range", `bytes */${info.size}`)
          .send({ error: "диапазон за пределами файла" });
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${info.size}`)
        .header("content-length", end - start + 1)
        .send(createReadStream(file, { start, end }));
    }

    return reply.header("content-length", info.size).send(createReadStream(file));
  }

  app.get<{ Params: { name: string } }>(
    "/download/:name(background|background-mobile).mp4",
    async (request, reply) =>
      sendRanged(request, reply, "download-" + request.params.name + ".mp4", "video/mp4")
  );

  app.get<{ Params: { name: string } }>(
    "/download/:name(secret-theme|pop).mp3",
    async (request, reply) =>
      sendRanged(request, reply, request.params.name + ".mp3", "audio/mpeg")
  );

  app.get<{ Params: { name: string } }>("/download/fonts/:name", async (request, reply) => {
    const data = fonts[request.params.name];
    if (!data) return reply.code(404).send({ error: "не найдено" });
    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .type("font/woff2")
      .send(Buffer.from(data, "base64"));
  });
}

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>G Launcher — скачать</title>
<meta name="description" content="Лаунчер Minecraft со сборками: моды, шейдеры и обновления ставятся сами." />
<link rel="icon" type="image/png" sizes="32x32" href="/download/favicon.png" />
<link rel="apple-touch-icon" href="/download/favicon-180.png" />
<link rel="stylesheet" href="/download/minecraft-react-ui.css" />
<style>
  /* Титульный экран в духе игрового меню. Шрифт и палитра — те же, что в
     самом лаунчере (src/styles.css). */
  @font-face {
    font-family: "Monocraft"; font-style: normal; font-weight: 400; font-display: block;
    src: url("/download/fonts/monocraft.woff2") format("woff2");
  }
  :root {
    --water-top: #4ad6ec; --water-mid: #18a8d4; --water-deep: #0d80b6;
    --grass: #93d84e; --grass-deep: #6cb62f;
    --danger: #b3392a; --splash: #ffdf3f;
    /* Пиксельная фаска: светлая грань сверху-слева, тёмная снизу-справа. */
    --px: 3px;
    --stone: #c9c9cd; --stone-hover: #dcdce0; --stone-hi: #ffffff; --stone-lo: #7a7a82;
    --panel: #d0d0d3; --panel-ink: #2b2b30; --outline: #3f3f46;
    /* Жёсткая тень-подложка: она и делает элемент выпуклым. */
    --drop: 3px 3px 0 rgba(0, 0, 0, 0.35);
    --sunk-hi: #8f8f96;
    --go: #4b9c2e; --go-deep: #3c8527; --go-hi: #63b843;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; }
  body {
    min-height: 100vh; color: #ffffff;
    font-family: "Monocraft", "Chalkboard SE", "Comic Sans MS", system-ui, sans-serif;
    /* Пока видео не залито — вода Jellyfish Fields, как раньше. */
    background: linear-gradient(180deg, var(--water-top) 0%, var(--water-mid) 48%, var(--water-deep) 100%);
    background-attachment: fixed;
  }

  /* Пасхалка: двадцать нажатий на кнопку подписи — и фон другой. Картинка
     маленькая, поэтому растягиваем её пикселями, а не мылом. */
  body.secret { background: #05070c url("/download/secret-bg.jpg") center / cover no-repeat fixed; }
  body.secret .bg { display: none; }
  body.secret .bg-dim { background: linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0.72)); }
  body.secret .splash { color: #ff5b5b; }

  /* --- Фон --- */
  .bg { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
  body.secret { image-rendering: pixelated; }
  .bg-dim {
    position: fixed; inset: 0; z-index: 1; pointer-events: none;
    /* Лёгкая виньетка: в игре панорама не гасится, контраст держат сами кнопки. */
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.16), rgba(0, 0, 0, 0.38));
  }
  /* Лучи света: остаются и поверх видео, и поверх воды. */
  .bg-dim::after {
    content: ""; position: absolute; inset: 0;
    background: repeating-linear-gradient(102deg, rgba(255,255,255,0.05) 0 42px, transparent 42px 150px);
  }

  /* --- Пузырьки: всплывают и лопаются по клику --- */
  .bubbles { position: fixed; inset: 0; z-index: 2; overflow: hidden; pointer-events: none; }
  .bubble { position: absolute; bottom: -80px; pointer-events: auto; cursor: pointer; animation: rise linear infinite; }
  /* Лента из 7 кадров: обычный пузырь и шесть кадров лопания. */
  .bubble .skin {
    display: block; width: 100%; height: 100%;
    background: url("/download/bubble.png") 0 0 / 700% 100% no-repeat;
    image-rendering: pixelated; transition: transform 0.12s ease;
  }
  .bubble:hover .skin { transform: scale(1.12); }
  .bubble.popping { animation-play-state: paused; pointer-events: none; }
  .bubble.popping .skin { transform: none; animation: pop 0.36s steps(1, end) forwards; }
  @keyframes rise {
    0%   { transform: translateY(0) translateX(0); opacity: 0; }
    10%  { opacity: 0.85; }
    50%  { transform: translateY(-55vh) translateX(20px); }
    90%  { opacity: 0.7; }
    100% { transform: translateY(-115vh) translateX(-16px); opacity: 0; }
  }
  /* Кадры со второго по седьмой: пузырь схлопывается и разлетается брызгами. */
  @keyframes pop {
    0%   { background-position-x: 16.6667%; }
    20%  { background-position-x: 33.3333%; }
    40%  { background-position-x: 50%; }
    60%  { background-position-x: 66.6667%; }
    80%  { background-position-x: 83.3333%; }
    100% { background-position-x: 100%; }
  }

  /* --- Экраны меню --- */
  .title {
    /* svh — высота без адресной строки: на мобильных 100vh уезжает под неё. */
    position: relative; z-index: 3; min-height: 100vh; min-height: 100svh;
    display: flex; align-items: center; justify-content: center; padding: 32px 16px 72px;
    /* Контейнер занимает весь экран и перехватывал бы клики по пузырькам —
       нажатия ловят только сами экраны меню. */
    pointer-events: none;
  }
  .screen { pointer-events: auto; }
  .screen { width: min(560px, 100%); display: flex; flex-direction: column; align-items: center; gap: 12px; }
  #screen-menu .menu { width: min(420px, 100%); }
  .screen-title { margin: 0 0 4px; font-size: 26px; text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.65); }

  /* Логотип по центру, подпись цепляется к его правому нижнему углу. */
  /* Композиция картинки смещена влево, поэтому подвигаем блок вправо. */
  .logo-wrap { position: relative; display: inline-block; margin-bottom: 20px; transform: translateX(20px); }
  .logo {
    display: block;
    width: min(540px, 88vw);
    height: auto;
    image-rendering: pixelated;
    filter: drop-shadow(4px 5px 0 rgba(0, 0, 0, 0.45));
  }
  /* Жёлтая подпись под углом — как в титульном экране игры. */
  .splash {
    position: absolute; right: -26px; bottom: -2px; max-width: 160px; text-align: center; line-height: 1.15;
    transform: rotate(-16deg);
    color: var(--splash); font-size: 17px; cursor: pointer; user-select: none;
    text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.55); animation: splash-beat 0.75s ease-in-out infinite alternate;
  }
  @keyframes splash-beat { from { transform: rotate(-16deg) scale(1); } to { transform: rotate(-16deg) scale(1.09); } }

  .menu { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  /* Квадратные кнопки по краям выходят за колонку, как в игровом меню. Вынос
     считается от их ширины с зазором — иначе средние кнопки не встают вровень
     с колонкой. */
  .row2 { --side: 46px; --gap: 8px; display: flex; gap: var(--gap); margin: 0 calc(-1 * (var(--side) + var(--gap))); }
  .row2 .Button { flex: 1; }

  /* --- Кнопка меню --- */
  /* Кнопки — классы .Button из minecraft-react-ui. Здесь только то, чего в
     библиотеке нет: ширина на всю колонку, размер и квадратные по краям. */
  .Button {
    /* Шрифт Minecraft с библиотекой не поставляется — без этого будут засечки. */
    font-family: inherit;
    width: 100%;
    padding: 12px 18px;
    font-size: 16px;
    text-decoration: none;
    box-shadow:
      inset 0 -2px 0 0 var(--bezel-color),
      inset -2px 0 0 0 var(--bezel-color),
      inset 0 2px 0 0 var(--bezel-color-invert),
      inset 2px 0 0 0 var(--bezel-color-invert),
      var(--drop);
  }
  .Button:disabled { cursor: not-allowed; opacity: 0.6; }
  .Button.square { width: var(--side, 46px); flex: 0 0 var(--side, 46px); padding: 12px 0; font-size: 18px; }

  /* --- Панель содержимого --- */
  .panel {
    width: 100%; padding: 18px; color: var(--panel-ink); background: var(--panel);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline),
      var(--drop);
  }
  .panel h3 { margin: 8px 0 6px; font-size: 16px; }
  .panel p { margin: 0; font-size: 13.5px; line-height: 1.5; color: #4a4a52; }

  /* --- Выбор системы --- */
  .os-tabs { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 16px; }
  /* Вкладка системы — их же кнопка, только с иконкой над подписью.
     Выбранная помечается штатным .Button_active. */
  .os-tab {
    flex-direction: column; gap: 5px; min-width: 110px; width: auto;
    padding: 10px 12px; font-size: 14px;
  }
  .os-ico { width: 28px; height: 28px; fill: currentColor; }
  .os-ico .dim { fill: rgba(0, 0, 0, 0.5); }
  .os-ico .beak { fill: #f7e3ad; }
  .os-name { font-size: 14px; }
  .os-count { font-size: 11px; opacity: 0.85; }
  .picked { margin-top: 10px; font-size: 13px; color: #4a4a52; text-align: center; }

  /* Строки файлов — как слоты инвентаря. */
  .others { margin-top: 18px; border-top: var(--px) solid var(--stone-lo); padding-top: 14px; }
  .others h3 { font-size: 13px; margin: 0 0 8px; color: #4a4a52; text-align: center; }
  .others a {
    display: flex; justify-content: space-between; gap: 12px; color: #f2f2f2; text-decoration: none;
    padding: 9px 12px; font-size: 13px; margin-bottom: 6px; background: #6f6f6f;
    text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.5);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-lo),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--sunk-hi),
      0 0 0 var(--px) var(--outline);
  }
  .others a:hover { background: var(--stone-hover); color: var(--panel-ink); text-shadow: none; }
  .others .size { white-space: nowrap; }

  .note { margin: 0; font-size: 12.5px; line-height: 1.55; text-align: center; color: #e8f6ff; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.5); }
  .error { color: #ffb3a6; font-weight: 700; }
  .soon { margin: 0; font-size: 15px; text-align: center; color: #3f3f46; }

  /* --- Что внутри / Как начать --- */
  .feats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  /* Иконки — pixelarticons (MIT, Gerrit Halfmann): 24×24 по пиксельной сетке. */
  .ico { width: 26px; height: 26px; fill: currentColor; display: block; }
  .ico.small { width: 20px; height: 20px; margin: 0 auto; }
  .ico-wrap { margin-bottom: 6px; }
  /* Пузырёк на кнопке — первый кадр нашей же ленты. */
  .bubble-ico {
    display: block; width: 20px; height: 20px; margin: 0 auto;
    background: url("/download/bubble.png") 0 0 / 700% 100% no-repeat;
    image-rendering: pixelated;
  }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  .steps li { display: flex; gap: 14px; align-items: flex-start; }
  .steps b { display: block; font-size: 15px; }
  .steps p { margin: 4px 0 0; }
  .num {
    flex: 0 0 auto; width: 32px; height: 32px; display: grid; place-items: center; color: #fff;
    text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.45);
    background: linear-gradient(180deg, var(--go-hi) 0 4px, var(--go) 4px, var(--go-deep));
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline);
  }

  /* --- Углы экрана, как в игре --- */
  .corner {
    position: fixed; z-index: 3; bottom: 8px; font-size: 12px; color: #ffffff;
    text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.6);
  }
  .corner.left { left: 10px; }
  .corner.right { right: 10px; }

  @media (max-width: 560px) {
    .title { padding: 16px 10px 52px; }
    .logo { width: 86vw; }
    .splash { right: -4px; bottom: -18px; font-size: 12px; max-width: 108px; }
    .logo-wrap { margin-bottom: 26px; }
    .screen { gap: 10px; }
    .screen-title { font-size: 20px; }
    .Button { padding: 12px 12px; font-size: 15px; }
    /* На узком экране выступать некуда — прижимаем к колонке. */
    .row2 { --side: 40px; margin: 0; }
    .panel { padding: 12px; }
    /* Три вкладки должны уместиться в ряд даже на узком экране. */
    .os-tabs { gap: 6px; }
    .os-tab { min-width: 0; flex: 1; padding: 8px 4px; }
    .os-name { font-size: 12px; }
    .os-count { font-size: 10px; }
    .os-ico { width: 24px; height: 24px; }
    .others a { font-size: 12px; padding: 8px 10px; gap: 8px; }
    /* Имя файла длинное — переносим по буквам, иначе ломает раскладку. */
    .others a span:first-child { overflow-wrap: anywhere; }
    .picked { font-size: 12px; overflow-wrap: anywhere; }
    .note { font-size: 12px; }
    .feats { grid-template-columns: 1fr; }
    .corner { font-size: 11px; bottom: 6px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bubble { display: none; }
    .splash { animation: none; }
  }
</style>
</head>
<body>
<video class="bg" id="bg" autoplay muted loop playsinline preload="auto" poster="/download/poster.jpg"></video>
<div class="bg-dim"></div>
<div class="bubbles" id="bubbles"></div>

<main class="title">
  <section class="screen" id="screen-menu">
    <div class="logo-wrap">
      <img class="logo" src="/download/logo.webp" alt="G LAND" />
      <div class="splash" id="splash" title="Нажми, чтобы сменить"></div>
    </div>
    <div class="menu">
      <button class="Button Button_primary" data-go="download">Скачать</button>
      <button class="Button Button_secondary" data-go="about">Что внутри</button>
      <button class="Button Button_secondary" data-go="start">Как начать</button>
      <div class="row2">
        <button class="Button Button_secondary square" id="bubbles-toggle" title="Больше пузырьков" aria-label="Больше пузырьков"><i class="bubble-ico"></i></button>
        <a class="Button Button_secondary" id="all-releases" href="https://github.com" target="_blank" rel="noreferrer">Все версии</a>
        <a class="Button Button_secondary" href="https://www.sbmania.net/" target="_blank" rel="noreferrer">Боб</a>
        <button class="Button Button_secondary square" id="splash-roll" title="Сменить подпись" aria-label="Сменить подпись"><svg class="ico small" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M11 1h2v4h-2zm0 22h2v-4h-2zM9 5h2v4H9zm0 14h2v-4H9zm4-14h2v4h-2zm0 14h2v-4h-2zM5 9h4v2H5zm14 0h-4v2h4zM1 11h4v2H1zm22 0h-4v2h4zM5 13h4v2H5zm14 0h-4v2h4zm0-12h2v6h-2z"/><path d="M17 3h6v2h-6zM3 17h2v2H3zm-2 2h2v2H1zm2 2h2v2H3zm2-2h2v2H5z"/></svg></button>
      </div>
    </div>
  </section>

  <section class="screen" id="screen-download" hidden>
    <h2 class="screen-title">Скачать лаунчер</h2>
    <div class="panel">
      <div class="os-tabs" id="os-tabs" role="tablist"></div>
      <div class="os-panel" id="os-panel"></div>
    </div>
    <p class="note">
      Лаунчер обновляется сам: при запуске проверяет новую версию, сверяет
      подпись и ставит в один клик. Возвращаться сюда не нужно.
    </p>
    <button class="Button Button_secondary" data-go="menu">Назад</button>
  </section>

  <section class="screen" id="screen-about" hidden>
    <h2 class="screen-title">Что внутри</h2>
    <div class="panel">
      <div class="feats">
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2zM8 9h2v6H8z"/><path d="M6 11h6v2H6zm8-2h2v2h-2zm2 4h2v2h-2z"/></svg></div>
          <h3>Режимы</h3>
          <p>Список сборок приезжает с сервера. Выбрал режим — лаунчер собрал его целиком и запустил игру.</p>
        </div>
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M14 4h4v2h-4zm-4-2h4v2h-4zM6 8h4v2H6zm0 10h4v2H6zm4-8h4v2h-4zm0 10h4v2h-4zm4-12h4v2h-4zm0 10h4v2h-4zM6 4h4v2H6zM2 6h4v2H2zm0 10h4v2H2zM18 6h4v2h-4zm0 10h4v2h-4z"/><path d="M2 6h2v12H2zm18 0h2v12h-2zm-8 6h2v8h-2z"/></svg></div>
          <h3>Все лоадеры</h3>
          <p>Ванилла, Fabric, Quilt, Forge, NeoForge. Forge ставится по-настоящему — с процессорами установщика.</p>
        </div>
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M4 4h16v2H4zm0 2h2v8H4zm2 8h10v2H6zm14-8h2v4h-2zm-2 4h2v2h-2zm-2-4h2v8h-2zM2 18h18v2H2z"/></svg></div>
          <h3>Java не нужна</h3>
          <p>Нужную версию лаунчер скачает с серверов Mojang сам. Свой путь тоже можно указать.</p>
        </div>
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/><path d="M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/><path d="M20 18H4v-2h16z"/></svg></div>
          <h3>Тихие обновления</h3>
          <p>Качается только новое, убранное из сборки стирается, а твои личные файлы не трогаются.</p>
        </div>
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M5 8h14v2H5zm0 12h14v2H5zM3 10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm2-2h6v2H9zm6 2h2v4h-2z"/></svg></div>
          <h3>Вход как удобно</h3>
          <p>По лицензии Microsoft или оффлайн по нику — для локальной игры с друзьями.</p>
        </div>
        <div>
          <div class="ico-wrap"><svg class="ico" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path d="M3 19h18v2H3zM5 5h2v14H5zm2-2h10v2H7zm10 2h2v14h-2zm-8 6h2v2H9z"/></svg></div>
          <h3>Кнопка в меню игры</h3>
          <p>Для Fabric- и Quilt-сборок с сервером в главном меню Minecraft появляется кнопка мгновенного захода.</p>
        </div>
      </div>
    </div>
    <button class="Button Button_secondary" data-go="menu">Назад</button>
  </section>

  <section class="screen" id="screen-start" hidden>
    <h2 class="screen-title">Как начать</h2>
    <div class="panel">
      <ol class="steps">
        <li>
          <span class="num">1</span>
          <div><b>Скачай и установи</b><p>Кнопка «Скачать» уже подбирает файл под твою систему.</p></div>
        </li>
        <li>
          <span class="num">2</span>
          <div><b>Войди</b><p>По лицензии Microsoft — или просто ником, если играешь оффлайн.</p></div>
        </li>
        <li>
          <span class="num">3</span>
          <div><b>Выбери режим и жми «Играть»</b><p>Первый запуск дольше — качается сама игра. Дальше только обновления.</p></div>
        </li>
      </ol>
    </div>
    <button class="Button Button_secondary" data-go="menu">Назад</button>
  </section>
</main>

<div class="corner left" id="corner-version">G Launcher</div>

<script>
  var NAMES = { macos: "macOS", windows: "Windows", linux: "Linux" };
  var ORDER = ["macos", "windows", "linux"];

  /* Иконки нарисованы прямоугольниками по сетке — под пиксельный интерфейс. */
  var ICONS = {
    macos:
      '<svg class="os-ico" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true">' +
      '<rect x="5" y="0" width="2" height="1"/><rect x="4" y="1" width="2" height="1"/>' +
      '<rect x="2" y="2" width="5" height="1"/><rect x="1" y="3" width="7" height="3"/>' +
      '<rect x="1" y="6" width="3" height="1"/><rect x="5" y="6" width="3" height="1"/>' +
      '<rect x="2" y="7" width="2" height="1"/><rect x="5" y="7" width="2" height="1"/></svg>',
    windows:
      '<svg class="os-ico" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true">' +
      '<rect x="0" y="0" width="4" height="4"/><rect x="5" y="0" width="4" height="4"/>' +
      '<rect x="0" y="5" width="4" height="4"/><rect x="5" y="5" width="4" height="4"/></svg>',
    // Пингвин: тёмная спина, светлый живот, жёлтые клюв и лапы — одноцветный
    // силуэт читался как привидение.
    linux:
      '<svg class="os-ico" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true">' +
      '<rect class="dim" x="3" y="0" width="3" height="1"/><rect class="dim" x="2" y="1" width="5" height="2"/>' +
      '<rect x="3" y="1" width="3" height="1"/>' +
      '<rect class="dim" x="3" y="1" width="1" height="1"/><rect class="dim" x="5" y="1" width="1" height="1"/>' +
      '<rect class="beak" x="4" y="2" width="1" height="1"/>' +
      '<rect class="dim" x="2" y="3" width="5" height="5"/>' +
      '<rect class="dim" x="1" y="4" width="1" height="3"/><rect class="dim" x="7" y="4" width="1" height="3"/>' +
      '<rect x="3" y="4" width="3" height="3"/>' +
      '<rect class="beak" x="1" y="8" width="3" height="1"/><rect class="beak" x="5" y="8" width="3" height="1"/></svg>',
  };

  /* --- Экраны меню --- */
  var SCREENS = ["menu", "download", "about", "start"];

  function show(name, keepHash) {
    SCREENS.forEach(function (id) {
      document.getElementById("screen-" + id).hidden = id !== name;
    });
    window.scrollTo(0, 0);
    // Экран остаётся в адресе: ссылкой можно вести сразу на загрузки,
    // а «назад» в браузере работает как кнопка «Назад» в меню.
    if (!keepHash) location.hash = name === "menu" ? "" : name;
  }

  function fromHash() {
    var name = location.hash.replace("#", "");
    show(SCREENS.indexOf(name) >= 0 ? name : "menu", true);
  }

  window.addEventListener("hashchange", fromHash);
  fromHash();

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-go]");
    if (target) show(target.dataset.go);
  });

  // Esc возвращает в меню — как в игре.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (typeof secretOn !== "undefined" && secretOn) secret(false);
    show("menu");
  });

  /* --- Жёлтая подпись --- */
  var SPLASHES = [
    "Моды ставятся сами!",
    "Java не нужна!",
    "Сверяет файлы по SHA-1!",
    "Forge ставится по-настоящему!",
    "Пузырьки лопаются!",
    "Обновляется сам!",
    "Сделано в Бикини Боттом!",
    "Осторожно, медузы!",
    "Пять модлоадеров!",
    "Не связано с Mojang!",
    "Работает и оффлайн!",
    "Твои файлы не трогает!",
    "Кнопка захода в меню игры!",
    "Шейдеры тоже приезжают!",
    "Первый запуск дольше, потерпи",
  ];

  var splash = document.getElementById("splash");
  function roll() {
    var next = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    splash.textContent = next === splash.textContent ? SPLASHES[0] : next;
  }
  splash.addEventListener("click", roll);
  roll();

  /* Пасхалка: двадцать нажатий на кнопку смены подписи включают 52 режим —
     другой фон и своя песня. Двадцать первое (или Esc) выключает обратно. */
  var SECRET_AT = 20;
  var secretHits = 0;
  var secretOn = false;
  var theme = null;

  function secret(on) {
    secretOn = on;
    document.body.classList.toggle("secret", on);
    if (on) {
      if (!theme) {
        theme = new Audio("/download/secret-theme.mp3");
        theme.loop = true;
        theme.volume = 0.6;
      }
      // Нажатие — это жест пользователя, поэтому автозапуск звука разрешён.
      theme.play().catch(function () { undefined; });
      splash.textContent = "52 режим";
    } else {
      if (theme) {
        theme.pause();
        theme.currentTime = 0;
      }
      secretHits = 0;
      roll();
    }
  }

  document.getElementById("splash-roll").addEventListener("click", function () {
    if (secretOn) {
      secret(false);
      return;
    }
    secretHits += 1;
    if (secretHits >= SECRET_AT) secret(true);
    else roll();
  });

  /* Кнопка в углу нижнего ряда удваивает пузырьки. Потолок нужен, чтобы
     страница не легла от тысячи анимаций; на потолке следующее нажатие
     возвращает исходное количество. */
  var BUBBLES_BASE = 18;
  var BUBBLES_MAX = 288;
  var bubbleCount = 0;
  var addBubbles = null;
  var resetBubbles = null;

  document.getElementById("bubbles-toggle").addEventListener("click", function () {
    if (!addBubbles) return;
    if (bubbleCount >= BUBBLES_MAX) {
      resetBubbles();
      return;
    }
    addBubbles(Math.min(bubbleCount, BUBBLES_MAX - bubbleCount));
  });

  /* --- Фон-видео. Нет файла — остаётся вода. --- */
  (function () {
    var video = document.getElementById("bg");
    // Видео нет — оставляем кадр-заглушку, если и его нет, останется вода.
    video.addEventListener("error", function () {
      video.removeAttribute("src");
      video.load();
    });

    // Тот же ролик в двух весах: на узком экране берём облегчённый, чтобы не
    // тянуть по мобильной сети лишнее. Кадр-заглушка видна, пока грузится.
    var light = window.matchMedia("(max-width: 900px)").matches
      || (navigator.connection && navigator.connection.saveData);
    video.src = light ? "/download/background-mobile.mp4" : "/download/background.mp4";

    // Safari на iOS решает про автозапуск в момент готовности элемента, а src мы
    // проставляем скриптом позже — поэтому просим проигрывание явно. В режиме
    // энергосбережения он всё равно откажет, тогда фон стартует с первого касания.
    function tryPlay() {
      var started = video.play();
      if (started && started.catch) started.catch(function () { undefined; });
    }

    video.addEventListener("loadeddata", tryPlay);
    tryPlay();
    window.addEventListener("pointerdown", tryPlay, { once: true });
    window.addEventListener("touchstart", tryPlay, { once: true });
  })();

  /* --- Данные релиза --- */
  function detect() {
    var ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return "macos";
    if (/Win/i.test(ua)) return "windows";
    return "linux";
  }

  function size(bytes) {
    var units = ["Б", "КБ", "МБ", "ГБ"];
    var value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
  }

  function plural(n) {
    var tail = n % 100 > 4 && n % 100 < 21 ? 0 : n % 10;
    if (tail === 1) return n + " файл";
    if (tail > 1 && tail < 5) return n + " файла";
    return n + " файлов";
  }

  function link(asset) {
    var a = document.createElement("a");
    a.href = asset.url;
    var name = document.createElement("span");
    name.textContent = asset.name;
    var s = document.createElement("span");
    s.className = "size";
    s.textContent = size(asset.size);
    a.appendChild(name);
    a.appendChild(s);
    return a;
  }

  fetch("/download/release.json")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("недоступно")); })
    .then(function (release) {
      var corner = document.getElementById("corner-version");
      var tabs = document.getElementById("os-tabs");
      var panel = document.getElementById("os-panel");

      if (release.repo) {
        document.getElementById("all-releases").href =
          "https://github.com/" + release.repo + "/releases";
      }

      // Релизов ещё не выпускали — это нормальное состояние, а не ошибка.
      var total = ORDER.reduce(function (n, os) { return n + release.assets[os].length; }, 0);
      if (!release.version || !total) {
        corner.textContent = "G Launcher · релиз готовится";
        var soon = document.createElement("p");
        soon.className = "soon";
        soon.textContent = "Сборки появятся здесь сразу после выпуска — страница подтянет их сама.";
        panel.appendChild(soon);
        return;
      }

      corner.textContent = "G Launcher " + release.version;
      if (release.publishedAt) {
        corner.textContent += " · " + new Date(release.publishedAt).toLocaleDateString("ru-RU", {
          day: "numeric", month: "long", year: "numeric"
        });
      }

      // Открытой оказывается вкладка системы посетителя. Нет под неё сборок —
      // открываем первую непустую, чтобы экран не выглядел сломанным.
      var mine = detect();
      if (!release.assets[mine].length) {
        mine = ORDER.filter(function (os) { return release.assets[os].length; })[0];
      }

      ORDER.forEach(function (os) {
        var files = release.assets[os];
        var tab = document.createElement("button");
        tab.className = "Button Button_secondary os-tab";
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.dataset.os = os;
        tab.disabled = !files.length;
        tab.innerHTML = ICONS[os];

        var name = document.createElement("span");
        name.className = "os-name";
        name.textContent = NAMES[os];
        tab.appendChild(name);

        var count = document.createElement("span");
        count.className = "os-count";
        count.textContent = files.length ? plural(files.length) : "нет сборки";
        tab.appendChild(count);

        tab.addEventListener("click", function () { select(os); });
        tabs.appendChild(tab);
      });

      function select(os) {
        var files = release.assets[os];
        if (!files.length) return;

        Array.prototype.forEach.call(tabs.children, function (tab) {
          var on = tab.dataset.os === os;
          tab.setAttribute("aria-selected", on ? "true" : "false");
          tab.classList.toggle("Button_active", on);
          tab.classList.toggle("Button_primary", on);
          tab.classList.toggle("Button_secondary", !on);
        });

        panel.textContent = "";

        // Первый файл — рекомендованный: под macOS это .dmg, под Windows .exe.
        var best = files[0];
        var main = document.createElement("a");
        main.className = "Button Button_primary";
        main.href = best.url;
        main.textContent = "Скачать для " + NAMES[os];
        panel.appendChild(main);

        var hint = document.createElement("div");
        hint.className = "picked";
        hint.textContent = best.name + " · " + size(best.size);
        panel.appendChild(hint);

        if (files.length > 1) {
          var more = document.createElement("div");
          more.className = "others";
          var title = document.createElement("h3");
          title.textContent = "Другие форматы для " + NAMES[os];
          more.appendChild(title);
          files.slice(1).forEach(function (asset) { more.appendChild(link(asset)); });
          panel.appendChild(more);
        }
      }

      select(mine);
    })
    .catch(function () {
      document.getElementById("corner-version").innerHTML =
        "<span class='error'>Список загрузок недоступен</span>";
      var panel = document.getElementById("os-panel");
      var warn = document.createElement("p");
      warn.className = "soon";
      warn.textContent = "Не удалось получить список загрузок. Попробуйте позже.";
      panel.appendChild(warn);
    });

  /* Щелчок лопающегося пузыря. Держим несколько копий и играем их по кругу:
     одному элементу пришлось бы обрываться на полузвуке, если лопать часто. */
  var popSounds = [];
  var popNext = 0;

  function playPop() {
    if (!popSounds.length) {
      for (var i = 0; i < 5; i += 1) {
        var sound = new Audio("/download/pop.mp3");
        sound.volume = 0.45;
        popSounds.push(sound);
      }
    }
    var current = popSounds[popNext];
    popNext = (popNext + 1) % popSounds.length;
    current.currentTime = 0;
    current.play().catch(function () { undefined; });
  }

  /* --- Пузырьки --- */
  (function () {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var layer = document.getElementById("bubbles");

    function spawn(atStart) {
      var box = document.createElement("div");
      box.className = "bubble";
      var d = 14 + Math.random() * 42;
      box.style.left = Math.random() * 98 + "%";
      box.style.width = d + "px";
      box.style.height = d + "px";
      // Крупные всплывают медленнее — так вода выглядит живой.
      var duration = 9 + (d / 56) * 8 + Math.random() * 4;
      box.style.animationDuration = duration + "s";
      // При загрузке раскидываем по всей высоте, чтобы не стартовать с пустого экрана.
      if (atStart) box.style.animationDelay = "-" + (Math.random() * duration) + "s";

      var skin = document.createElement("span");
      skin.className = "skin";
      box.appendChild(skin);

      box.addEventListener("animationend", function (event) {
        if (event.animationName !== "rise") return;
        box.remove();
        spawn(false);
      });

      box.addEventListener("pointerdown", function () {
        box.classList.add("popping");
        playPop();
        setTimeout(function () { box.remove(); spawn(false); }, 320);
      });

      layer.appendChild(box);
    }

    addBubbles = function (count) {
      for (var i = 0; i < count; i += 1) spawn(true);
      bubbleCount += count;
    };

    resetBubbles = function () {
      layer.textContent = "";
      bubbleCount = 0;
      addBubbles(BUBBLES_BASE);
    };

    resetBubbles();
  })();
</script>
</body>
</html>
`;
