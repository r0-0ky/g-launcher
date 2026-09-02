#!/bin/sh
# Сертификат Let's Encrypt: выпуск и продление.
#
# Домен, как и у nginx, берём из PUBLIC_URL. Пока A-запись домена не ведёт на
# эту машину, проверка не пройдёт — это нормально, просто пробуем снова. Так
# переезд с чужого прокси не требует ничего, кроме переключения DNS: сертификат
# выпишется сам в течение минуты после него.

set -eu

DOMAIN="$(printf '%s' "${PUBLIC_URL:?PUBLIC_URL не задан в .env}" | sed -e 's#^[a-z][a-z]*://##' -e 's#[:/].*##')"
if [ -z "$DOMAIN" ]; then
  echo "Из PUBLIC_URL=$PUBLIC_URL не вышло достать домен" >&2
  exit 1
fi

# Почта необязательна: без неё Let's Encrypt просто не пришлёт письмо о том,
# что сертификат скоро истечёт. Продление от этого не зависит.
if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
  contact="--email $LETSENCRYPT_EMAIL"
else
  contact="--register-unsafely-without-email"
fi

while [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; do
  echo "certbot: прошу сертификат для $DOMAIN"
  if certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
      $contact --agree-tos --non-interactive --keep-until-expiring; then
    echo "certbot: получен"
  else
    echo "certbot: не вышло — обычно это значит, что домен ещё не смотрит сюда."
    echo "certbot: повтор через минуту"
    sleep 60
  fi
done

echo "certbot: сертификат на месте, дальше только продление"
while :; do
  # Дважды в сутки — так советует сам Let's Encrypt: продление начинается за
  # 30 дней до конца, и промахнуться мимо окна невозможно.
  sleep 43200
  certbot renew --webroot -w /var/www/certbot --quiet || echo "certbot: продление не удалось, повторю позже"
done
