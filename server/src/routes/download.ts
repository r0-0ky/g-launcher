import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { PIXELIFY_CYRILLIC_BASE64, PIXELIFY_LATIN_BASE64 } from "./fonts.js";

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
  /* Шрифт и палитра те же, что в самом лаунчере (src/styles.css): вода
     Jellyfish Fields плюс пиксельные панели в духе Minecraft. */
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
    --sand: #f7e3ad; --danger: #b3392a;
    /* Пиксельная фаска: светлая грань сверху-слева, тёмная снизу-справа. */
    --px: 3px;
    --stone: #c9c9cd; --stone-hover: #dcdce0; --stone-hi: #ffffff; --stone-lo: #7a7a82;
    --panel: #d0d0d3; --panel-ink: #2b2b30; --outline: #3f3f46;
    /* Жёсткая тень-подложка: она и делает элемент выпуклым. */
    --drop: 3px 3px 0 rgba(0, 0, 0, 0.35);
    --go: #4b9c2e; --go-deep: #3c8527; --go-hi: #63b843;
    /* Нижняя грань вдавленных поверхностей: белая била бы по глазам на тёмном. */
    --sunk-hi: #8f8f96;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; }
  /* Пиксельный шрифт — только на заголовки и кнопки: в нём «5» похожа на «S»,
     а «ы» и «ш» нарисованы латиницей, поэтому версии и размеры файлов
     оставляем обычным шрифтом. */
  h1, h2, h3, a.primary, .num, .section-title, .soon {
    font-family: "Pixelify Sans", "Chalkboard SE", "Comic Sans MS", system-ui, sans-serif;
    font-weight: 400; letter-spacing: 0.4px;
  }
  body {
    min-height: 100vh; color: var(--panel-ink);
    font-family: "Chalkboard SE", "Comic Sans MS", "Comic Neue", "Marker Felt", system-ui, sans-serif;
    background: linear-gradient(180deg, var(--water-top) 0%, var(--water-mid) 48%, var(--water-deep) 100%);
    background-attachment: fixed;
    padding: 40px 16px 0;
  }
  /* Лучи света сквозь воду */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background: repeating-linear-gradient(102deg, rgba(255,255,255,0.07) 0 42px, transparent 42px 150px);
  }

  /* --- Дно: песок и водоросли --- */
  .seabed { position: fixed; left: 0; right: 0; bottom: 0; height: 150px; z-index: 0; pointer-events: none; }
  .sand {
    position: absolute; left: -10px; right: -10px; bottom: 0; height: 70px;
    background: var(--sand); box-shadow: inset 0 var(--px) 0 0 #fff3cf, 0 0 0 var(--px) var(--outline);
  }
  .blade {
    position: absolute; bottom: 56px; width: 15px;
    background: linear-gradient(180deg, var(--grass), var(--grass-deep));
    box-shadow: 0 0 0 var(--px) var(--outline); transform-origin: bottom center;
    animation: sway 6s ease-in-out infinite;
  }
  @keyframes sway {
    0%, 100% { transform: rotate(-8deg); }
    50% { transform: rotate(8deg); }
  }

  /* --- Пузырьки: всплывают и лопаются по клику --- */
  .bubbles { position: fixed; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
  .bubble {
    position: absolute; bottom: -80px; pointer-events: auto; cursor: pointer;
    animation: rise linear infinite;
  }
  .bubble .skin {
    display: block; width: 100%; height: 100%; border-radius: 50%;
    background: radial-gradient(circle at 32% 30%, rgba(255,255,255,0.95), rgba(255,255,255,0.18) 60%, transparent 72%);
    border: 1.5px solid rgba(255, 255, 255, 0.65);
    transition: transform 0.12s ease;
  }
  .bubble:hover .skin { transform: scale(1.12); }
  .bubble.popping { animation-play-state: paused; pointer-events: none; }
  .bubble.popping .skin { animation: pop 0.32s ease-out forwards; }
  @keyframes rise {
    0%   { transform: translateY(0) translateX(0); opacity: 0; }
    10%  { opacity: 0.9; }
    50%  { transform: translateY(-55vh) translateX(20px); }
    90%  { opacity: 0.75; }
    100% { transform: translateY(-115vh) translateX(-16px); opacity: 0; }
  }
  /* Сначала чуть сжимается, потом разлетается — так клик читается как «лопнул» */
  @keyframes pop {
    0%   { transform: scale(1); opacity: 0.95; }
    35%  { transform: scale(0.8); opacity: 1; border-width: 3px; }
    100% { transform: scale(1.8); opacity: 0; border-width: 1px; }
  }

  /* --- Контент --- */
  main { position: relative; z-index: 2; max-width: 880px; margin: 0 auto; }
  /* Каменная панель: фаска вместо скругления и мягкой тени. */
  .card {
    background: var(--panel);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline),
      var(--drop);
  }
  .hero { padding: 30px 28px 26px; text-align: center; }
  .mark { font-size: 44px; line-height: 1; animation: sway 7s ease-in-out infinite; display: inline-block; }
  h1 { margin: 6px 0 6px; font-size: 34px; letter-spacing: 0.3px; }
  .tagline { margin: 0 auto 14px; max-width: 30em; font-size: 15px; line-height: 1.5; color: #4a4a52; }
  .version {
    display: inline-block; font-weight: 700; font-size: 13px; margin-bottom: 20px;
    padding: 5px 14px; background: var(--stone); color: var(--panel-ink);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline);
  }
  a.primary {
    display: block; max-width: 420px; margin: 0 auto; text-align: center;
    text-decoration: none; color: #fff; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.55);
    background: linear-gradient(180deg, var(--go-hi) 0 4px, var(--go) 4px, var(--go-deep));
    padding: 16px 24px; font-size: 19px; font-weight: 700;
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline);
  }
  a.primary:hover { background: linear-gradient(180deg, #79cc53 0 4px, var(--go-hi) 4px, var(--go)); }
  /* Нажатие вдавливает кнопку: фаска переворачивается. */
  a.primary:active {
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-lo),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-hi),
      0 0 0 var(--px) var(--outline);
  }
  /* Вкладки систем: своя открыта сразу, остальные рядом. */
  .os-tabs { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 18px; }
  .os-tab {
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    min-width: 118px; padding: 12px 14px; font: inherit; cursor: pointer;
    background: var(--stone); color: var(--panel-ink);
    border: none; border-radius: 0;
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
    /* Выбранная вкладка вдавлена — как нажатая клавиша. */
    box-shadow:
      inset var(--px) var(--px) 0 0 rgba(0, 0, 0, 0.25),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 rgba(255, 255, 255, 0.35),
      0 0 0 var(--px) var(--outline);
  }
  .os-tab:disabled { background: #9a9aa0; color: #e2e2e6; cursor: not-allowed; box-shadow: 0 0 0 var(--px) var(--outline); }
  .os-ico { width: 30px; height: 30px; fill: currentColor; }
  .os-ico .dim { fill: rgba(0, 0, 0, 0.5); }
  .os-ico .beak { fill: var(--sand); }
  .os-name { font-size: 15px; }
  .os-count { font-size: 11px; opacity: 0.85; }
  .picked { margin-top: 10px; font-size: 13px; color: #4a4a52; }
  .others { margin-top: 20px; border-top: var(--px) solid var(--stone-lo); padding-top: 14px; text-align: left; }
  .others h2 { font-size: 14px; margin: 0 0 8px; color: #4a4a52; text-align: center; }
  /* Строки — как слоты инвентаря. */
  .others a {
    display: flex; justify-content: space-between; gap: 12px; color: #f2f2f2;
    text-decoration: none; padding: 9px 12px; font-size: 14px; margin-bottom: 6px;
    background: #6f6f6f; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.5);
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-lo),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--sunk-hi),
      0 0 0 var(--px) var(--outline);
  }
  .others a:hover { background: var(--stone-hover); }
  .others .size { color: #d9d9d9; white-space: nowrap; }
  .note { margin: 18px auto 0; max-width: 34em; font-size: 13px; line-height: 1.55; color: #4a4a52; }
  .error { color: var(--danger); font-weight: 700; }
  .soon { margin: 0; font-weight: 700; font-size: 15px; color: #3f3f46; }

  .section-title {
    color: #ffffff; text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.55);
    font-size: 22px; text-align: center; margin: 34px 0 14px;
  }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
  .feat {
    background: var(--panel); padding: 16px 18px;
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline),
      var(--drop);
  }
  .feat .ico { font-size: 26px; line-height: 1; }
  .feat h3 { margin: 8px 0 6px; font-size: 16px; }
  .feat p { margin: 0; font-size: 13.5px; line-height: 1.5; color: #4a4a52; }

  .steps { padding: 24px 28px; }
  .steps h2 { margin: 0 0 16px; font-size: 20px; text-align: center; }
  .steps ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  .steps li { display: flex; gap: 14px; align-items: flex-start; }
  .num {
    flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center;
    font-weight: 700; color: #fff; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.55);
    background: linear-gradient(180deg, var(--go-hi) 0 4px, var(--go) 4px, var(--go-deep));
    box-shadow:
      inset var(--px) var(--px) 0 0 var(--stone-hi),
      inset calc(-1 * var(--px)) calc(-1 * var(--px)) 0 0 var(--stone-lo),
      0 0 0 var(--px) var(--outline);
  }
  .steps p { margin: 5px 0 0; font-size: 14px; line-height: 1.5; }
  .steps b { display: block; font-size: 15px; }

  footer {
    position: relative; z-index: 2; max-width: 880px; margin: 26px auto 0;
    padding-bottom: 190px; text-align: center; color: #ffffff; font-size: 13px;
    line-height: 1.7; text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.55);
  }
  footer a { color: #fff; }

  @media (max-width: 560px) {
    h1 { font-size: 27px; }
    .hero { padding: 24px 18px 22px; }
  }
  /* Кому анимация мешает — вода замирает, страница остаётся рабочей */
  @media (prefers-reduced-motion: reduce) {
    .blade, .mark { animation: none; }
    .bubble { display: none; }
  }
</style>
</head>
<body>
<div class="bubbles" id="bubbles"></div>
<div class="seabed" aria-hidden="true">
  <div class="blade" style="left: 4%;  height: 74px;"></div>
  <div class="blade" style="left: 9%;  height: 46px; animation-delay: -1.5s;"></div>
  <div class="blade" style="left: 21%; height: 60px; animation-delay: -3s;"></div>
  <div class="blade" style="left: 44%; height: 40px; animation-delay: -2.2s;"></div>
  <div class="blade" style="left: 63%; height: 66px; animation-delay: -0.8s;"></div>
  <div class="blade" style="left: 78%; height: 50px; animation-delay: -3.6s;"></div>
  <div class="blade" style="left: 92%; height: 80px; animation-delay: -1.1s;"></div>
  <div class="sand"></div>
</div>

<main>
  <section class="card hero">
    <div class="mark">🍍</div>
    <h1>Gandoni Launcher</h1>
    <p class="tagline">
      Свой лаунчер Minecraft: выбираешь режим — версия игры, модлоадер, моды,
      шейдеры и Java приезжают сами. Ничего вручную раскладывать по папкам не надо.
    </p>
    <div class="version" id="version">загружаем…</div>
    <div class="os-tabs" id="os-tabs" role="tablist" hidden></div>
    <div class="os-panel" id="os-panel"></div>
    <p class="note">
      Лаунчер обновляется сам: при запуске проверяет новую версию, скачивает,
      сверяет подпись и ставит в один клик. Возвращаться сюда после каждого
      обновления не нужно.
    </p>
  </section>

  <h2 class="section-title">Что внутри</h2>
  <div class="grid">
    <div class="feat">
      <div class="ico">🎮</div>
      <h3>Режимы</h3>
      <p>Список сборок приезжает с сервера. Выбрал режим — лаунчер собрал его целиком и запустил игру.</p>
    </div>
    <div class="feat">
      <div class="ico">🧩</div>
      <h3>Все лоадеры</h3>
      <p>Ванилла, Fabric, Quilt, Forge, NeoForge. Forge ставится по-настоящему — с процессорами установщика, как официальный инсталлятор.</p>
    </div>
    <div class="feat">
      <div class="ico">☕</div>
      <h3>Java не нужна</h3>
      <p>Нужную версию лаунчер скачает с серверов Mojang сам. Свой путь тоже можно указать, если он уже есть.</p>
    </div>
    <div class="feat">
      <div class="ico">🔄</div>
      <h3>Тихие обновления</h3>
      <p>Сравнение по SHA-1: качается только новое, убранное из сборки стирается, а твои личные файлы не трогаются.</p>
    </div>
    <div class="feat">
      <div class="ico">🔐</div>
      <h3>Вход как удобно</h3>
      <p>По лицензии Microsoft или оффлайн по нику — второе пригодится для локальной игры с друзьями.</p>
    </div>
    <div class="feat">
      <div class="ico">🚀</div>
      <h3>Кнопка в меню игры</h3>
      <p>Для Fabric- и Quilt-сборок с сервером в главном меню Minecraft появляется кнопка мгновенного захода.</p>
    </div>
  </div>

  <h2 class="section-title">Как начать</h2>
  <section class="card steps">
    <ol>
      <li>
        <span class="num">1</span>
        <div><b>Скачай и установи</b><p>Кнопка вверху уже подобрана под твою систему.</p></div>
      </li>
      <li>
        <span class="num">2</span>
        <div><b>Войди</b><p>По лицензии Microsoft — или просто ником, если играешь оффлайн.</p></div>
      </li>
      <li>
        <span class="num">3</span>
        <div><b>Выбери режим и жми «Играть»</b><p>Первый запуск дольше — качается сама игра. Дальше только обновления, это быстро.</p></div>
      </li>
    </ol>
  </section>
</main>

<footer>
  <div><a id="all-releases" href="#" hidden>Все версии и список изменений на GitHub</a></div>
  <div>Пузырьки лопаются, если по ним щёлкнуть 🫧</div>
</footer>

<script>
  var NAMES = { macos: "macOS", windows: "Windows", linux: "Linux" };
  var ORDER = ["macos", "windows", "linux"];

  /* Иконки нарисованы прямоугольниками по сетке — чтобы совпадать с пиксельным
     интерфейсом лаунчера. Цвет наследуется от вкладки. */
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
    // Пингвин: тёмная спина, светлый живот, жёлтые клюв и лапы — иначе
    // одноцветный силуэт читается как привидение.
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

  function plural(n) {
    var tail = n % 100 > 4 && n % 100 < 21 ? 0 : n % 10;
    if (tail === 1) return n + " файл";
    if (tail > 1 && tail < 5) return n + " файла";
    return n + " файлов";
  }

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
      var label = "версия " + release.version;
      if (release.publishedAt) {
        label += " · " + new Date(release.publishedAt).toLocaleDateString("ru-RU", {
          day: "numeric", month: "long", year: "numeric"
        });
      }
      document.getElementById("version").textContent = label;

      if (release.repo) {
        var all = document.getElementById("all-releases");
        all.href = "https://github.com/" + release.repo + "/releases";
        all.hidden = false;
      }

      var tabs = document.getElementById("os-tabs");
      var panel = document.getElementById("os-panel");

      // Релизов ещё не выпускали — это нормальное состояние, а не ошибка.
      var total = ORDER.reduce(function (n, os) { return n + release.assets[os].length; }, 0);
      if (!release.version || !total) {
        document.getElementById("version").textContent = "первый релиз ещё готовится";
        var soon = document.createElement("p");
        soon.className = "soon";
        soon.textContent = "Сборки появятся здесь сразу после выпуска — страница подтянет их сама.";
        panel.appendChild(soon);
        return;
      }

      // Открытой оказывается вкладка системы посетителя. Если под неё сборок
      // в релизе нет — открываем первую непустую, чтобы страница не выглядела
      // сломанной.
      var mine = detect();
      if (!release.assets[mine].length) {
        mine = ORDER.filter(function (os) { return release.assets[os].length; })[0];
      }

      tabs.hidden = false;
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
        main.className = "primary";
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
          var title = document.createElement("h2");
          title.textContent = "Другие форматы для " + NAMES[os];
          more.appendChild(title);
          files.slice(1).forEach(function (asset) { more.appendChild(link(asset)); });
          panel.appendChild(more);
        }
      }

      select(mine);
    })
    .catch(function () {
      var box = document.getElementById("version");
      box.textContent = "Не удалось получить список загрузок. Попробуйте позже.";
      box.className = "version error";
    });

  /* --- Пузырьки --- */
  (function () {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var layer = document.getElementById("bubbles");
    var COUNT = 22;

    function spawn(atStart) {
      var box = document.createElement("div");
      box.className = "bubble";
      var d = 14 + Math.random() * 42;
      box.style.left = Math.random() * 98 + "%";
      box.style.width = d + "px";
      box.style.height = d + "px";
      // Крупные всплывают медленнее — так вода выглядит живой, а не как дождь наоборот.
      var duration = 9 + (d / 56) * 8 + Math.random() * 4;
      box.style.animationDuration = duration + "s";
      // При загрузке раскидываем пузырьки по всей высоте, чтобы не стартовать с пустого экрана.
      if (atStart) box.style.animationDelay = "-" + (Math.random() * duration) + "s";

      var skin = document.createElement("span");
      skin.className = "skin";
      box.appendChild(skin);

      // Долетел до поверхности — исчез, вместо него пойдёт новый.
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
