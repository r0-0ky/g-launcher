# G Launcher — бэкенд + админка

Один Node-сервис (Fastify + SQLite), который:

- раздаёт `manifest.json` и файлы модов для лаунчера;
- содержит веб-админку на `/admin` — там ты собираешь сборки: выбираешь версию
  и модлоадер, добавляешь моды, шейдеры и ресурс-паки поиском по Modrinth или
  заливкой своих файлов, и переключателем показываешь сборку в лаунчере.

Данные (база + загруженные файлы) лежат в одной папке `DATA_DIR` — её и надо бэкапить.

## Быстрый старт локально

```bash
cd server
cp .env.example .env          # впиши ADMIN_PASSWORD
npm install
npm run dev                   # API на :8080, админка (Vite) на :5174
```

Открой http://localhost:5174 — это админка в режиме разработки с hot reload.
Прод-версия (собранная админка на том же порту, что и API) — `npm run build && npm start`,
затем http://localhost:8080/admin.

## Деплой на VPS

Схема: пуш в `main` → GitHub Actions собирает Docker-образ и кладёт в GHCR → по SSH
даёт VPS команду забрать образ и перезапуститься. Наружу сервер смотрит через
Cloudflare Tunnel, поэтому открытых портов, nginx и certbot не нужно вовсе.

```
push → GitHub Actions → ghcr.io/r0-0ky/g-launcher/server:latest
                              ↓ ssh: docker compose pull && up -d
                    VPS: gandoni ← cloudflared ← Cloudflare ← игроки
```

Сборка идёт на раннере GitHub — VPS не компилирует `better-sqlite3` и не нагружается.

### 1. Подготовка VPS

Нужен сервер с Ubuntu/Debian и SSH-доступом. Домен должен быть добавлен в Cloudflare
(NS-серверы Cloudflare), но DNS-записи руками создавать не надо — туннель сделает сам.

```bash
# на VPS, один раз
curl -fsSL https://raw.githubusercontent.com/r0-0ky/g-launcher/main/server/deploy/bootstrap.sh | sudo bash
```

Скрипт ставит Docker, создаёт `/srv/g-launcher` и шаблон `.env` с уже подставленным
репозиторием. Заполнить руками надо два поля: `ADMIN_PASSWORD` (длинный случайный)
и `PUBLIC_URL` (твой домен), плюс `TUNNEL_TOKEN` из следующего шага.

### 2. Cloudflare Tunnel

1. Cloudflare → **Zero Trust** → Networks → **Tunnels** → Create a tunnel → **Cloudflared**.
2. Назови туннель, на шаге «Install and run a connector» скопируй **токен** — строку
   после `--token`. Сам коннектор ставить не надо: его поднимет `docker compose`.
   Токен → в `TUNNEL_TOKEN` в `/srv/g-launcher/.env`.
3. Вкладка **Public Hostname** → Add a public hostname:
   - Subdomain/Domain: `launcher.example.com`
   - Type: **HTTP**, URL: **`gandoni:8080`** — это имя сервиса из `docker-compose.yml`,
     контейнеры видят друг друга по нему.

Сертификат и HTTPS Cloudflare берёт на себя. Входящие порты на VPS можно закрыть все,
кроме SSH — туннель работает исходящим соединением.

### 3. Доступ для GitHub Actions

На VPS создай ключ для деплоя (без пароля — им пользуется робот):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gandoni-deploy -N "" -C "github-actions"
cat ~/.ssh/gandoni-deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/gandoni-deploy          # приватный — в секрет VPS_SSH_KEY
ssh-keyscan -H "$(curl -s ifconfig.me)"   # строки — в секрет VPS_KNOWN_HOSTS
```

Секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Значение |
| --- | --- |
| `VPS_HOST` | IP или домен сервера |
| `VPS_USER` | пользователь SSH |
| `VPS_SSH_KEY` | приватный ключ целиком, вместе со строками `-----BEGIN...` |
| `VPS_PATH` | `/srv/g-launcher` (необязательно, это же значение по умолчанию) |
| `VPS_PORT` | порт SSH, если не 22 (необязательно) |
| `VPS_KNOWN_HOSTS` | вывод `ssh-keyscan` (необязательно, но так безопаснее) |

И один раз открой доступ к образу — он появится после первой сборки:
[github.com/r0-0ky?tab=packages](https://github.com/r0-0ky?tab=packages) →
`g-launcher/server` → Package settings → **Change visibility → Public**.
Иначе VPS не сможет его скачать без логина в GHCR.

### 4. Первый деплой

Пушни в `main` — [`deploy-server.yml`](../.github/workflows/deploy-server.yml) соберёт
образ, зальёт `docker-compose.yml` на сервер, поднимет контейнеры и дождётся, пока
healthcheck станет `healthy`. Если контейнер не поднялся, workflow упадёт и покажет
последние 50 строк логов.

Дальше каждый пуш в `main` деплоится сам. Ручной запуск — кнопка **Run workflow**.

### Откат

```bash
# на VPS
cd /srv/g-launcher
nano .env      # SERVER_IMAGE=ghcr.io/r0-0ky/g-launcher/server:sha-<коммит>
docker compose up -d
```

Каждая сборка тегируется и как `latest`, и как `sha-<коммит>`, так что вернуться
на любую прошлую версию можно за секунды. `SERVER_IMAGE` в `.env` деплой
перезаписывает сам — правка держится до следующего пуша в `main`.

### Ограничения Cloudflare

- **100 МБ на запрос** на бесплатном тарифе. Сам сервер размер загрузки не
  ограничивает, но этот лимит снять нельзя: мод тяжелее 100 МБ Cloudflare
  оборвёт на полпути. Хочешь понятную ошибку вместо обрыва — поставь
  `MAX_UPLOAD_MB=95` в `.env`. А если такой мод всё же нужен — залей файл на VPS
  и подложи в `data/files` вручную либо временно открой порт напрямую.
- Ответ должен начаться за 100 секунд, иначе Cloudflare отдаст 524. На раздачу
  jar-ов это не влияет — они отдаются сразу.
- `.jar` попадает под стандартное кэширование Cloudflare, а файлы у нас адресуются
  по SHA-1 и помечены `immutable` — то есть моды игрокам раздаёт CDN, а не твой VPS.
  Это бонус, а не проблема.

Если Cloudflare не нужен, старая схема с nginx и certbot никуда не делась —
[`nginx.conf.example`](nginx.conf.example) на месте, надо только вернуть в
`docker-compose.yml` публикацию порта `127.0.0.1:8080:8080` и убрать сервис `cloudflared`.

Готово. Теперь:

- **Корень домена**: `https://launcher.example.com` — редирект на страницу загрузки,
  туда попадают игроки
- **Админка**: `https://launcher.example.com/admin`
- **Ссылка для лаунчера** (её вставить в настройки лаунчера или в `DEFAULT_MANIFEST_URL`):
  `https://launcher.example.com/manifest.json`
- **Страница загрузки лаунчера**: `https://launcher.example.com/download`

### Страница загрузки

`/download` сделана как титульный экран игры: меню с разделами «Скачать»,
«Что внутри» и «Как начать». Раздел пишется в адрес, поэтому ссылкой можно вести
сразу на загрузки — `/download#download`.

Фон — видео из [`assets/download-background.mp4`](assets/README.md). Файл лежит
в репозитории и едет в образе; чтобы заменить его на живом сервере без пересборки,
положи файл с тем же именем в `DATA_DIR` — он перебивает вшитый. Нет ни одного —
останется градиент воды.

Данные о версии берутся из релизов GitHub — задай в `.env`:

```
GITHUB_REPO=r0-0ky/g-launcher
```

Ответ GitHub кэшируется на 5 минут, наружу отдаётся своим же адресом
`/download/release.json`. Если упрёшься в лимит GitHub API (60 запросов в час на
IP), добавь `GITHUB_TOKEN` с правом чтения публичных репозиториев.

Сами файлы лежат на GitHub — сервер их не хранит и не раздаёт, так что трафик
загрузок его не касается.

### Бэкап и диагностика

```bash
cd /srv/g-launcher

# бэкап — просто папка data (база + залитые моды)
tar czf gandoni-backup-$(date +%F).tgz data

docker compose ps                      # статус и здоровье контейнеров
docker compose logs -f gandoni         # логи сервера
docker compose logs -f cloudflared     # логи туннеля, если домен не отвечает
docker compose exec gandoni node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

Обновление кодом отдельно запускать не надо — его делает пуш в `main`.

## Как пользоваться админкой

1. Войди по паролю из `ADMIN_PASSWORD`.
2. **+ Новая сборка** → название и версия Minecraft. id генерируется автоматически.
3. Вкладка **Основное**: модлоадер (версия подтягивается под выбранный Minecraft),
   память, адрес сервера, иконка/баннер, папки под контролем лаунчера.
4. Вкладка **Содержимое**:
   - **Из Modrinth** — поиск уже отфильтрован по версии и лоадеру сборки;
     кнопка добавляет файл, обязательные зависимости подтягиваются сами.
   - **Загрузить файлы** — свои jar-ы, конфиги, приватные моды, паки.
   - Галочка «необяз.» — файл ставится один раз, игрок может его удалить.
5. Переключатель **● Видна в лаунчере** — сборка появляется в `manifest.json`.
   Пока он выключен, сборку видишь только ты.

Изменения попадают в лаунчер сразу: он сравнивает файлы по SHA-1, докачивает новое
и удаляет убранное. Файлы Modrinth раздаются с их CDN, свои — с твоего сервера
(по хэшу, поэтому один и тот же мод в разных сборках не занимает место дважды).

## Переменные окружения

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `ADMIN_PASSWORD` | — | Пароль входа в админку. **Обязателен.** |
| `PUBLIC_URL` | из заголовков | Базовый адрес в ссылках манифеста |
| `PORT` | `8080` | Порт HTTP |
| `DATA_DIR` | `./data` | Папка с базой и файлами |
| `MAX_UPLOAD_MB` | без лимита | Предел на один загружаемый файл, если он нужен |
| `SESSION_TTL_HOURS` | `24` | Время жизни сессии админки |

## API (кратко)

Публичное (без авторизации):

- `GET /manifest.json` — то, что читает лаунчер (только видимые сборки)
- `GET /files/:sha1/:filename` — загруженный файл
- `GET /health`

Админское (заголовок `Authorization: Bearer <token>`, токен из `POST /api/login`):

- `GET/POST/PUT/DELETE /api/modes[/:id]` — сборки
- `POST /api/modes/:id/duplicate` — клонировать сборку с содержимым
- `POST /api/modes/:id/files/upload?kind=mod|shader|resourcepack|config|other`
- `POST /api/modes/:id/files/modrinth` — добавить из Modrinth
- `PATCH/DELETE /api/modes/:id/files/:fileId`
- `GET /api/modrinth/search`, `GET /api/modrinth/versions`
- `GET /api/minecraft/versions`, `GET /api/loader/versions`
- `GET /api/manifest/preview` — манифест со скрытыми сборками
```
