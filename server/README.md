# Gandoni Launcher — бэкенд + админка

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

## Деплой на VPS через Docker

Нужен сервер с Docker, доменом и открытыми портами 80/443.

```bash
# 1. Скопируй папку server/ на VPS (scp/git/rsync), зайди в неё
cd server

# 2. Настрой окружение
cp .env.example .env
nano .env
#   ADMIN_PASSWORD=длинный-случайный-пароль
#   PUBLIC_URL=https://launcher.example.com   ← твой домен

# 3. Собери и запусти
docker compose up -d --build

# 4. Проверь, что живой
curl http://127.0.0.1:8080/health      # {"ok":true}
```

Контейнер слушает только `127.0.0.1:8080` — наружу его выставляет nginx.

### nginx + HTTPS

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/launcher.example.com
sudo nano /etc/nginx/sites-available/launcher.example.com   # заменить домен
sudo ln -s /etc/nginx/sites-available/launcher.example.com /etc/nginx/sites-enabled/
sudo certbot --nginx -d launcher.example.com                # выпустит сертификат
sudo nginx -t && sudo systemctl reload nginx
```

Готово. Теперь:

- **Админка**: `https://launcher.example.com/admin`
- **Ссылка для лаунчера** (её вставить в настройки лаунчера или в `DEFAULT_MANIFEST_URL`):
  `https://launcher.example.com/manifest.json`
- **Страница загрузки лаунчера**: `https://launcher.example.com/download`

### Страница загрузки

`/download` показывает последнюю версию лаунчера и кнопку под систему посетителя.
Данные берутся из релизов GitHub — задай в `.env`:

```
GITHUB_REPO=owner/gandoni-launcher
```

Ответ GitHub кэшируется на 5 минут, наружу отдаётся своим же адресом
`/download/release.json`. Если упрёшься в лимит GitHub API (60 запросов в час на
IP), добавь `GITHUB_TOKEN` с правом чтения публичных репозиториев.

Сами файлы лежат на GitHub — сервер их не хранит и не раздаёт, так что трафик
загрузок его не касается.

### Обновление и бэкап

```bash
git pull                       # или залей новую версию
docker compose up -d --build   # пересборка без простоя данных

# бэкап — просто папка data
tar czf gandoni-backup-$(date +%F).tgz data
```

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
| `MAX_UPLOAD_MB` | `512` | Лимит на один загружаемый файл |
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
