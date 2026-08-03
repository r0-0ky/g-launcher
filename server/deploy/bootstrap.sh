#!/usr/bin/env bash
# Первичная настройка VPS под Gandoni Launcher.
# Ставит Docker, создаёт папку деплоя и шаблон .env. Запускать один раз, на сервере:
#
#   curl -fsSL https://raw.githubusercontent.com/r0-0ky/g-launcher/main/server/deploy/bootstrap.sh | sudo bash
#
# или просто скопировать файл и выполнить `sudo bash bootstrap.sh`.
# Дальше сервер поднимет GitHub Actions — вручную запускать ничего не нужно.

set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/gandoni}"
# Владелец папки: тот, под кем будет ходить деплой. По умолчанию — вызвавший sudo.
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-$(id -un)}}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo: sudo bash bootstrap.sh" >&2
  exit 1
fi

echo "==> Папка деплоя: $DEPLOY_PATH (владелец $DEPLOY_USER)"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Ставлю Docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "==> Docker уже стоит: $(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker есть, а плагина compose нет. Поставьте docker-compose-plugin и повторите." >&2
  exit 1
fi

# Чтобы деплой ходил без sudo.
if [ "$DEPLOY_USER" != "root" ]; then
  usermod -aG docker "$DEPLOY_USER"
  echo "==> $DEPLOY_USER добавлен в группу docker (нужен новый вход по SSH)"
fi

systemctl enable --now docker

mkdir -p "$DEPLOY_PATH/data"

if [ -f "$DEPLOY_PATH/.env" ]; then
  echo "==> .env уже есть, не трогаю"
else
  echo "==> Создаю шаблон .env"
  cat > "$DEPLOY_PATH/.env" <<'ENV'
# Пароль входа в админку — обязательно смените на длинный случайный.
ADMIN_PASSWORD=

# Домен, который отдаёт Cloudflare Tunnel.
PUBLIC_URL=https://launcher.example.com

# Репозиторий с релизами лаунчера — для страницы /download.
GITHUB_REPO=r0-0ky/g-launcher

# Образ, который выкладывает GitHub Actions.
SERVER_IMAGE=ghcr.io/r0-0ky/g-launcher/server:latest

# Токен из Cloudflare Zero Trust → Networks → Tunnels → Install connector.
TUNNEL_TOKEN=

# Cloudflare режет тело запроса на 100 МБ — просим админку ругаться заранее.
MAX_UPLOAD_MB=95
ENV
fi

chmod 600 "$DEPLOY_PATH/.env"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_PATH"

cat <<NEXT

Готово. Осталось:

  1. Заполнить $DEPLOY_PATH/.env — ADMIN_PASSWORD, PUBLIC_URL, GITHUB_REPO,
     SERVER_IMAGE (свой owner) и TUNNEL_TOKEN.
  2. Положить публичный ключ деплоя в ~$DEPLOY_USER/.ssh/authorized_keys.
  3. Прописать в Cloudflare публичный хостнейм туннеля на http://gandoni:8080.
  4. Пушнуть в main — workflow deploy-server сам зальёт compose-файл и поднимет сервис.

Проверка после первого деплоя:
  cd $DEPLOY_PATH && docker compose ps
NEXT
