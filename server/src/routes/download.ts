import type { FastifyInstance } from "fastify";

import { config } from "../config.js";

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
}

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gandoni Launcher — скачать</title>
<meta name="description" content="Лаунчер Minecraft со сборками: моды, шейдеры и обновления ставятся сами." />
<style>
  /* Палитра и шрифт те же, что в самом лаунчере (src/styles.css) — Jellyfish Fields. */
  :root {
    --water-top: #4ad6ec; --water-mid: #18a8d4; --water-deep: #0d80b6;
    --grass: #93d84e; --grass-deep: #6cb62f;
    --sunny: #ffd744; --sunny-deep: #f0b21e;
    --ink: #0f3646; --paper: #fdf7ea; --sand: #f7e3ad; --danger: #c23a26;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; }
  body {
    min-height: 100vh; color: var(--ink);
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
    background: var(--sand); border-top: 5px solid var(--ink); border-radius: 40% 55% 0 0 / 26px 22px 0 0;
  }
  .blade {
    position: absolute; bottom: 56px; width: 15px; border-radius: 10px 10px 4px 4px;
    background: linear-gradient(180deg, var(--grass), var(--grass-deep));
    border: 3px solid var(--ink); transform-origin: bottom center;
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
  .card {
    background: var(--paper); border: 5px solid var(--ink); border-radius: 28px;
    box-shadow: 6px 8px 0 rgba(10, 40, 60, 0.35);
  }
  .hero { padding: 30px 28px 26px; text-align: center; }
  .mark { font-size: 44px; line-height: 1; animation: sway 7s ease-in-out infinite; display: inline-block; }
  h1 { margin: 6px 0 6px; font-size: 34px; letter-spacing: 0.3px; }
  .tagline { margin: 0 auto 14px; max-width: 30em; font-size: 15px; line-height: 1.5; opacity: 0.85; }
  .version {
    display: inline-block; font-weight: 700; font-size: 13px; margin-bottom: 20px;
    background: rgba(147, 216, 78, 0.35); border: 2.5px solid var(--ink);
    border-radius: 999px; padding: 4px 14px;
  }
  a.primary {
    display: block; max-width: 420px; margin: 0 auto; text-align: center;
    text-decoration: none; color: var(--ink);
    background: linear-gradient(180deg, var(--sunny), var(--sunny-deep));
    border: 4px solid var(--ink); border-radius: 18px; padding: 16px 24px;
    font-size: 19px; font-weight: 900; box-shadow: 3px 4px 0 rgba(10, 40, 60, 0.35);
    transition: transform 0.12s ease;
  }
  a.primary:hover { transform: scale(1.03) rotate(-1deg); }
  .others { margin-top: 20px; border-top: 3px dashed rgba(15, 54, 70, 0.25); padding-top: 14px; text-align: left; }
  .others h2 { font-size: 14px; margin: 0 0 8px; opacity: 0.75; text-align: center; }
  .others a {
    display: flex; justify-content: space-between; gap: 12px; color: var(--ink);
    text-decoration: none; padding: 8px 12px; border-radius: 12px; font-size: 14px;
  }
  .others a:hover { background: rgba(147, 216, 78, 0.3); }
  .others .size { opacity: 0.6; white-space: nowrap; }
  .note { margin: 18px auto 0; max-width: 34em; font-size: 13px; line-height: 1.55; opacity: 0.8; }
  .error { color: var(--danger); font-weight: 700; }
  .soon { margin: 0; font-weight: 700; font-size: 15px; opacity: 0.85; }

  .section-title {
    color: #f2fbff; text-shadow: 2px 2px 0 rgba(10, 40, 60, 0.45);
    font-size: 22px; text-align: center; margin: 34px 0 14px;
  }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
  .feat {
    background: var(--paper); border: 4px solid var(--ink); border-radius: 20px;
    padding: 16px 18px; box-shadow: 4px 5px 0 rgba(10, 40, 60, 0.3);
    transition: transform 0.15s ease;
  }
  .feat:hover { transform: translateY(-4px) rotate(-1deg); }
  .feat .ico { font-size: 26px; line-height: 1; }
  .feat h3 { margin: 8px 0 6px; font-size: 16px; }
  .feat p { margin: 0; font-size: 13.5px; line-height: 1.5; opacity: 0.85; }

  .steps { padding: 24px 28px; }
  .steps h2 { margin: 0 0 16px; font-size: 20px; text-align: center; }
  .steps ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  .steps li { display: flex; gap: 14px; align-items: flex-start; }
  .num {
    flex: 0 0 auto; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 900; background: linear-gradient(180deg, var(--sunny), var(--sunny-deep));
    border: 3px solid var(--ink); box-shadow: 2px 2px 0 rgba(10, 40, 60, 0.3);
  }
  .steps p { margin: 5px 0 0; font-size: 14px; line-height: 1.5; }
  .steps b { display: block; font-size: 15px; }

  footer {
    position: relative; z-index: 2; max-width: 880px; margin: 26px auto 0;
    padding-bottom: 190px; text-align: center; color: #eaf9ff; font-size: 13px;
    line-height: 1.7; text-shadow: 1px 1px 0 rgba(10, 40, 60, 0.5);
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
    <div id="primary"></div>
    <div class="others" id="others" hidden>
      <h2>Другие системы</h2>
      <div id="others-list"></div>
    </div>
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

      var box = document.getElementById("primary");

      // Релизов ещё не выпускали — это нормальное состояние, а не ошибка.
      var total = ["macos", "windows", "linux"].reduce(function (n, os) {
        return n + release.assets[os].length;
      }, 0);
      if (!release.version || !total) {
        document.getElementById("version").textContent = "первый релиз ещё готовится";
        var soon = document.createElement("p");
        soon.className = "soon";
        soon.textContent = "Сборки появятся здесь сразу после выпуска — страница подтянет их сама.";
        box.appendChild(soon);
        return;
      }

      var mine = detect();
      var primary = release.assets[mine][0];
      if (primary) {
        var a = document.createElement("a");
        a.className = "primary";
        a.href = primary.url;
        a.textContent = "Скачать для " + NAMES[mine];
        box.appendChild(a);
      } else {
        var warn = document.createElement("p");
        warn.className = "error";
        warn.textContent = "Для " + NAMES[mine] + " сборки в этом релизе нет — посмотри другие системы ниже.";
        box.appendChild(warn);
      }

      var rest = [];
      ["macos", "windows", "linux"].forEach(function (os) {
        release.assets[os].forEach(function (asset) {
          if (asset !== primary) rest.push(asset);
        });
      });
      if (rest.length) {
        document.getElementById("others").hidden = false;
        var list = document.getElementById("others-list");
        rest.forEach(function (asset) { list.appendChild(link(asset)); });
      }
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
