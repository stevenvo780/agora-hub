#!/usr/bin/env bash
set -euo pipefail

PARENT_HOST=${PARENT_HOST:-stev@10.88.88.1}
NAS_HOST=${NAS_HOST:-nas@100.98.67.189}
NAS_BASE=${NAS_BASE:-/mnt/pool/datos/educacion-cooperativa/postgres}
LOCAL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "$LOCAL_DIR/docker-compose.yml" ]]; then
  echo "docker-compose.yml not found in $LOCAL_DIR" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_DIR/.env" ]]; then
  echo "Refusing to deploy without $LOCAL_DIR/.env." >&2
  echo "Create it from .env.example using a password stored in Vaultwarden." >&2
  exit 1
fi

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'hostname && whoami && command -v docker && docker compose version'"

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'set -euo pipefail; mkdir -p \"$NAS_BASE/compose\" \"$NAS_BASE/data\" \"$NAS_BASE/backups\" \"$NAS_BASE/init\"; chmod 700 \"$NAS_BASE\" \"$NAS_BASE/data\" \"$NAS_BASE/backups\"'"

scp -o ProxyCommand="ssh $PARENT_HOST -W %h:%p" \
  "$LOCAL_DIR/docker-compose.yml" \
  "$LOCAL_DIR/.env" \
  "$NAS_HOST:$NAS_BASE/compose/"

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'set -euo pipefail; chmod 600 \"$NAS_BASE/compose/.env\"; cd \"$NAS_BASE/compose\"; docker compose pull; docker compose up -d; docker compose ps'"
