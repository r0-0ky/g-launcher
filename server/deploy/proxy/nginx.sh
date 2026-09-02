#!/bin/sh
# Запуск nginx перед сервером.
#
# Домен берём из PUBLIC_URL — он и так лежит в .env, отдельной переменной не
# заводим. Сертификата на первом запуске ещё нет, поэтому поднимаемся по http,
# а когда certbot его выпишет — сами переезжаем на https. Тем же путём
# подхватывается продление: nginx о нём иначе не узнает.

set -eu

DOMAIN="$(printf '%s' "${PUBLIC_URL:?PUBLIC_URL не задан в .env}" | sed -e 's#^[a-z][a-z]*://##' -e 's#[:/].*##')"
if [ -z "$DOMAIN" ]; then
  echo "Из PUBLIC_URL=$PUBLIC_URL не вышло достать домен" >&2
  exit 1
fi

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
OUT=/etc/nginx/conf.d/default.conf

render() {
  if [ -f "$CERT" ]; then
    sed "s/{{DOMAIN}}/$DOMAIN/g" /templates/site-tls.conf > "$OUT"
  else
    sed "s/{{DOMAIN}}/$DOMAIN/g" /templates/site-http.conf > "$OUT"
  fi
}

# Метка сертификата: по её изменению понимаем и первый выпуск, и продление.
stamp() {
  if [ -f "$CERT" ]; then
    stat -c %Y "$CERT"
  else
    echo none
  fi
}

render
echo "nginx: домен $DOMAIN, сертификат $([ -f "$CERT" ] && echo есть || echo ещё нет)"

nginx -g 'daemon off;' &
pid=$!

last="$(stamp)"
while kill -0 "$pid" 2>/dev/null; do
  sleep 30
  now="$(stamp)"
  [ "$now" = "$last" ] || {
    last="$now"
    echo "nginx: сертификат обновился, перечитываю конфиг"
    render
    nginx -t && nginx -s reload
  }
done

wait "$pid"
