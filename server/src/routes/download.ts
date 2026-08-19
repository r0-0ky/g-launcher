import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { PIXELIFY_CYRILLIC_BASE64, PIXELIFY_LATIN_BASE64 } from "./fonts.js";

/**
 * Фон титульного экрана. Файл кладётся руками в DATA_DIR — так его можно
 * заменить, не пересобирая образ:
 *
 *   scp video.mp4 сервер:/srv/g-launcher/data/download-background.mp4
 *
 * Нет файла — страница просто останется с градиентом воды.
 */
const BACKGROUND = "download-background.mp4";

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
    "pixelify-latin.woff2": PIXELIFY_LATIN_BASE64,
    "pixelify-cyrillic.woff2": PIXELIFY_CYRILLIC_BASE64,
  };

  app.get("/download/background.mp4", async (request, reply) => {
    const file = resolve(config.dataDir, BACKGROUND);
    if (!existsSync(file)) {
      return reply.code(404).send({ error: "фон не загружен" });
    }

    const info = statSync(file);
    reply
      .header("accept-ranges", "bytes")
      .header("cache-control", "public, max-age=600")
      .type("video/mp4");

    // Браузеры (особенно Safari) просят видео кусками — без этого фон не поедет.
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
  });

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
<title>Gandoni Launcher — скачать</title>
<meta name="description" content="Лаунчер Minecraft со сборками: моды, шейдеры и обновления ставятся сами." />
<style>
  /* Титульный экран в духе игрового меню. Шрифт и палитра — те же, что в
     самом лаунчере (src/styles.css). */
  @font-face {
    font-family: "Pixelify Sans"; font-style: normal; font-weight: 400 700; font-display: block;
    src: url("/download/fonts/pixelify-latin.woff2") format("woff2");
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+2000-206F, U+2190-2193, U+2212;
  }
  @font-face {
    font-family: "Pixelify Sans"; font-style: normal; font-weight: 400 700; font-display: block;
    src: url("/download/fonts/pixelify-cyrillic.woff2") format("woff2");
    unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
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
    font-family: "Chalkboard SE", "Comic Sans MS", "Comic Neue", "Marker Felt", system-ui, sans-serif;
    /* Пока видео не залито — вода Jellyfish Fields, как раньше. */
    background: linear-gradient(180deg, var(--water-top) 0%, var(--water-mid) 48%, var(--water-deep) 100%);
    background-attachment: fixed;
  }
  /* Пиксельный шрифт — на заголовки и кнопки: в нём «5» похожа на «S», а «ы»
     и «ш» нарисованы латиницей, поэтому версии и размеры остаются обычным. */
  h1, h2, h3, .mc-btn, .logo, .splash, .num, .soon {
    font-family: "Pixelify Sans", "Chalkboard SE", "Comic Sans MS", system-ui, sans-serif;
    font-weight: 400; letter-spacing: 0.4px;
  }

  /* --- Фон --- */
  .bg { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
  .bg-dim {
    position: fixed; inset: 0; z-index: 1; pointer-events: none;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.68));
  }
  /* Лучи света: остаются и поверх видео, и поверх воды. */
  .bg-dim::after {
    content: ""; position: absolute; inset: 0;
    background: repeating-linear-gradient(102deg, rgba(255,255,255,0.05) 0 42px, transparent 42px 150px);
  }

  /* --- Пузырьки: всплывают и лопаются по клику --- */
  .bubbles { position: fixed; inset: 0; z-index: 2; overflow: hidden; pointer-events: none; }
  .bubble { position: absolute; bottom: -80px; pointer-events: auto; cursor: pointer; animation: rise linear infinite; }
  .bubble .skin {
    display: block; width: 100%; height: 100%; border-radius: 50%;
    background: radial-gradient(circle at 32% 30%, rgba(255,255,255,0.95), rgba(255,255,255,0.18) 60%, transparent 72%);
    border: 1.5px solid rgba(255, 255, 255, 0.65); transition: transform 0.12s ease;
  }
  .bubble:hover .skin { transform: scale(1.12); }
  .bubble.popping { animation-play-state: paused; pointer-events: none; }
  .bubble.popping .skin { animation: pop 0.32s ease-out forwards; }
  @keyframes rise {
    0%   { transform: translateY(0) translateX(0); opacity: 0; }
    10%  { opacity: 0.85; }
    50%  { transform: translateY(-55vh) translateX(20px); }
    90%  { opacity: 0.7; }
    100% { transform: translateY(-115vh) translateX(-16px); opacity: 0; }
  }
  @keyframes pop {
    0%   { transform: scale(1); opacity: 0.95; }
    35%  { transform: scale(0.8); opacity: 1; border-width: 3px; }
    100% { transform: scale(1.8); opacity: 0; border-width: 1px; }
  }

  /* --- Экраны меню --- */
  .title {
    position: relative; z-index: 3; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 56px 16px 72px;
  }
  .screen { width: min(560px, 100%); display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .screen-title { margin: 0 0 4px; font-size: 26px; text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.65); }

  .logo-wrap { position: relative; text-align: center; margin-bottom: 18px; }
  .logo {
    margin: 0; font-size: clamp(38px, 9vw, 68px); line-height: 0.95; color: #ffffff;
    text-shadow: 5px 5px 0 rgba(0, 0, 0, 0.6);
  }
  .logo .sub { display: block; font-size: 0.52em; color: #d8f4ff; }
  /* Жёлтая подпись под углом — как в титульном экране игры. */
  .splash {
    position: absolute; right: -76px; bottom: 34px; transform: rotate(-16deg);
    color: var(--splash); font-size: 17px; cursor: pointer; user-select: none;
    text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.55); animation: splash-beat 0.75s ease-in-out infinite alternate;
  }
  @keyframes splash-beat { from { transform: rotate(-16deg) scale(1); } to { transform: rotate(-16deg) scale(1.09); } }

  .menu { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .row2 { display: flex; gap: 10px; }
  .row2 .mc-btn { flex: 1; }

  /* --- Кнопка меню --- */
  .mc-btn {
    display: block; width: 100%; padding: 14px 18px; font-size: 17px; text-align: center;
    text-decoration: none; cursor: pointer; border: none; border-radius: 0;
    background: var(--stone); color: var(--panel-ink);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline),
      var(--drop);
  }
  .mc-btn:hover:not(:disabled) { background: var(--stone-hover); }
  /* Нажатие вдавливает: фаска переворачивается, подложка уходит. */
  .mc-btn:active:not(:disabled) {
    box-shadow:
      inset var(--px) var(--px) 0 0 rgba(0, 0, 0, 0.25),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 rgba(255, 255, 255, 0.4),
      0 0 0 var(--px) var(--outline);
  }
  .mc-btn.go {
    background: linear-gradient(180deg, var(--go-hi) 0 4px, var(--go) 4px, var(--go-deep));
    color: #ffffff; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.45); font-size: 19px; padding: 16px 18px;
  }
  .mc-btn.go:hover { background: linear-gradient(180deg, #79cc53 0 4px, var(--go-hi) 4px, var(--go)); }
  .mc-btn:disabled { background: #9a9aa0; color: #e2e2e6; cursor: not-allowed; }

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
  .os-tab {
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    min-width: 110px; padding: 10px 12px; font: inherit; cursor: pointer;
    background: var(--stone); color: var(--panel-ink); border: none; border-radius: 0;
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline),
      var(--drop);
  }
  .os-tab:hover:not(:disabled):not(.active) { background: var(--stone-hover); }
  .os-tab.active {
    background: linear-gradient(180deg, var(--go-hi) 0 4px, var(--go) 4px, var(--go-deep));
    color: #fff; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.45);
    box-shadow:
      inset var(--px) var(--px) 0 0 rgba(0, 0, 0, 0.25),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 rgba(255, 255, 255, 0.35),
      0 0 0 var(--px) var(--outline);
  }
  .os-tab:disabled { background: #9a9aa0; color: #e2e2e6; cursor: not-allowed; box-shadow: 0 0 0 var(--px) var(--outline); }
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
  .feat .ico { font-size: 24px; line-height: 1; }
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
    .splash { right: -8px; bottom: -30px; font-size: 14px; }
    .title { padding: 40px 12px 64px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bubble { display: none; }
    .splash { animation: none; }
  }
</style>
</head>
<body>
<video class="bg" id="bg" autoplay muted loop playsinline preload="auto"></video>
<div class="bg-dim"></div>
<div class="bubbles" id="bubbles"></div>

<main class="title">
  <section class="screen" id="screen-menu">
    <div class="logo-wrap">
      <h1 class="logo">Gandoni<span class="sub">Launcher</span></h1>
      <div class="splash" id="splash" title="Нажми, чтобы сменить"></div>
    </div>
    <div class="menu">
      <button class="mc-btn go" data-go="download">Скачать</button>
      <button class="mc-btn" data-go="about">Что внутри</button>
      <button class="mc-btn" data-go="start">Как начать</button>
      <a class="mc-btn" id="all-releases" href="https://github.com" target="_blank" rel="noreferrer">Все версии</a>
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
    <button class="mc-btn" data-go="menu">Назад</button>
  </section>

  <section class="screen" id="screen-about" hidden>
    <h2 class="screen-title">Что внутри</h2>
    <div class="panel">
      <div class="feats">
        <div>
          <div class="ico">🎮</div>
          <h3>Режимы</h3>
          <p>Список сборок приезжает с сервера. Выбрал режим — лаунчер собрал его целиком и запустил игру.</p>
        </div>
        <div>
          <div class="ico">🧩</div>
          <h3>Все лоадеры</h3>
          <p>Ванилла, Fabric, Quilt, Forge, NeoForge. Forge ставится по-настоящему — с процессорами установщика.</p>
        </div>
        <div>
          <div class="ico">☕</div>
          <h3>Java не нужна</h3>
          <p>Нужную версию лаунчер скачает с серверов Mojang сам. Свой путь тоже можно указать.</p>
        </div>
        <div>
          <div class="ico">🔄</div>
          <h3>Тихие обновления</h3>
          <p>Качается только новое, убранное из сборки стирается, а твои личные файлы не трогаются.</p>
        </div>
        <div>
          <div class="ico">🔐</div>
          <h3>Вход как удобно</h3>
          <p>По лицензии Microsoft или оффлайн по нику — для локальной игры с друзьями.</p>
        </div>
        <div>
          <div class="ico">🚀</div>
          <h3>Кнопка в меню игры</h3>
          <p>Для Fabric- и Quilt-сборок с сервером в главном меню Minecraft появляется кнопка мгновенного захода.</p>
        </div>
      </div>
    </div>
    <button class="mc-btn" data-go="menu">Назад</button>
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
    <button class="mc-btn" data-go="menu">Назад</button>
  </section>
</main>

<div class="corner left" id="corner-version">Gandoni Launcher</div>
<div class="corner right">Не связано с Mojang · пузырьки лопаются 🫧</div>

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
    if (event.key === "Escape") show("menu");
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

  /* --- Фон-видео. Нет файла — остаётся вода. --- */
  (function () {
    var video = document.getElementById("bg");
    video.addEventListener("error", function () { video.remove(); });
    video.src = "/download/background.mp4";
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
        corner.textContent = "Gandoni Launcher · релиз готовится";
        var soon = document.createElement("p");
        soon.className = "soon";
        soon.textContent = "Сборки появятся здесь сразу после выпуска — страница подтянет их сама.";
        panel.appendChild(soon);
        return;
      }

      corner.textContent = "Gandoni Launcher " + release.version;
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
        tab.className = "os-tab";
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
          tab.classList.toggle("active", on);
        });

        panel.textContent = "";

        // Первый файл — рекомендованный: под macOS это .dmg, под Windows .exe.
        var best = files[0];
        var main = document.createElement("a");
        main.className = "mc-btn go";
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

  /* --- Пузырьки --- */
  (function () {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var layer = document.getElementById("bubbles");
    var COUNT = 18;

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
        setTimeout(function () { box.remove(); spawn(false); }, 320);
      });

      layer.appendChild(box);
    }

    for (var i = 0; i < COUNT; i += 1) spawn(true);
  })();
</script>
</body>
</html>
`;
