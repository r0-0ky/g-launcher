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
<style>
  :root {
    --water-top: #4ad6ec; --water-deep: #0d80b6; --grass: #93d84e;
    --sunny: #ffd744; --sunny-deep: #f0b21e; --ink: #0f3646; --paper: #fdf7ea;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; color: var(--ink);
    font-family: "Chalkboard SE", "Comic Sans MS", "Comic Neue", system-ui, sans-serif;
    background: linear-gradient(180deg, var(--water-top), var(--water-deep));
    display: flex; align-items: center; justify-content: center; padding: 32px 16px;
  }
  main {
    width: 100%; max-width: 560px; background: var(--paper);
    border: 5px solid var(--ink); border-radius: 28px; padding: 28px;
    box-shadow: 6px 8px 0 rgba(10, 40, 60, 0.35);
  }
  h1 { margin: 0 0 4px; font-size: 30px; }
  .version { font-weight: 700; opacity: 0.7; margin-bottom: 22px; }
  a.primary {
    display: block; text-align: center; text-decoration: none; color: var(--ink);
    background: linear-gradient(180deg, var(--sunny), var(--sunny-deep));
    border: 4px solid var(--ink); border-radius: 18px; padding: 16px 24px;
    font-size: 19px; font-weight: 900; box-shadow: 3px 4px 0 rgba(10, 40, 60, 0.35);
    transition: transform 0.12s ease;
  }
  a.primary:hover { transform: scale(1.03) rotate(-1deg); }
  .others { margin-top: 22px; border-top: 3px dashed rgba(15, 54, 70, 0.25); padding-top: 16px; }
  .others h2 { font-size: 15px; margin: 0 0 10px; opacity: 0.75; }
  .others a {
    display: flex; justify-content: space-between; gap: 12px; color: var(--ink);
    text-decoration: none; padding: 8px 12px; border-radius: 12px; font-size: 14px;
  }
  .others a:hover { background: rgba(147, 216, 78, 0.3); }
  .others .size { opacity: 0.6; white-space: nowrap; }
  .note { margin-top: 20px; font-size: 13px; line-height: 1.5; opacity: 0.8; }
  .error { color: #c23a26; font-weight: 700; }
</style>
</head>
<body>
<main>
  <h1>Gandoni Launcher</h1>
  <div class="version" id="version">загружаем…</div>
  <div id="primary"></div>
  <div class="others" id="others" hidden>
    <h2>Другие системы</h2>
    <div id="others-list"></div>
  </div>
  <p class="note">
    Лаунчер обновляется сам: при запуске он проверяет новую версию и ставит её
    в один клик. Скачивать заново после каждого обновления не нужно.
  </p>
</main>
<script>
  const NAMES = { macos: "macOS", windows: "Windows", linux: "Linux" };

  function detect() {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return "macos";
    if (/Win/i.test(ua)) return "windows";
    return "linux";
  }

  function size(bytes) {
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
  }

  function link(asset) {
    const a = document.createElement("a");
    a.href = asset.url;
    a.innerHTML = "<span>" + asset.name + "</span><span class='size'>" + size(asset.size) + "</span>";
    return a;
  }

  fetch("/download/release.json")
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("недоступно")))
    .then((release) => {
      document.getElementById("version").textContent = "версия " + release.version;

      const mine = detect();
      const primary = release.assets[mine][0];
      const box = document.getElementById("primary");
      if (primary) {
        const a = document.createElement("a");
        a.className = "primary";
        a.href = primary.url;
        a.textContent = "Скачать для " + NAMES[mine];
        box.appendChild(a);
      } else {
        box.innerHTML = "<p class='error'>Для " + NAMES[mine] + " сборки в этом релизе нет.</p>";
      }

      const rest = [];
      for (const os of ["macos", "windows", "linux"]) {
        for (const asset of release.assets[os]) {
          if (asset !== primary) rest.push(asset);
        }
      }
      if (rest.length) {
        document.getElementById("others").hidden = false;
        const list = document.getElementById("others-list");
        rest.forEach((asset) => list.appendChild(link(asset)));
      }
    })
    .catch(() => {
      document.getElementById("version").innerHTML =
        "<span class='error'>Не удалось получить список загрузок. Попробуйте позже.</span>";
    });
</script>
</body>
</html>
`;
