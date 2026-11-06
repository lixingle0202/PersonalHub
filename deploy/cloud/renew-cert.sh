#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
docker compose -f compose.cloud.yaml run --rm certbot renew --quiet
docker compose -f compose.cloud.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile.https --adapter caddyfile
