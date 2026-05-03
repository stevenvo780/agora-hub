#!/usr/bin/env bash
set -euo pipefail

PARENT_HOST=${PARENT_HOST:-stev@10.88.88.1}
NAS_HOST=${NAS_HOST:-nas@100.98.67.189}
NAS_BASE=${NAS_BASE:-/mnt/pool/datos/educacion-cooperativa/postgres}
DB_NAME=${POSTGRES_DB:-educacion_cooperativa}
DB_USER=${POSTGRES_USER:-educacion_cooperativa_app}

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'set -euo pipefail; cd \"$NAS_BASE/compose\"; docker compose ps; docker compose exec -T postgres pg_isready -U \"$DB_USER\" -d \"$DB_NAME\"'"

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'set -euo pipefail; cd \"$NAS_BASE/compose\"; docker compose exec -T postgres psql -U \"$DB_USER\" -d \"$DB_NAME\" -v ON_ERROR_STOP=1 -c \"CREATE TABLE IF NOT EXISTS deployment_persistence_check (id integer primary key, checked_at timestamptz not null default now()); INSERT INTO deployment_persistence_check (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET checked_at = now(); SELECT * FROM deployment_persistence_check;\"; docker compose restart postgres; docker compose exec -T postgres psql -U \"$DB_USER\" -d \"$DB_NAME\" -v ON_ERROR_STOP=1 -c \"SELECT * FROM deployment_persistence_check;\"'"

ssh "$PARENT_HOST" "ssh '$NAS_HOST' 'set -euo pipefail; ss -tulpen | grep -E \":5433\\b|:5432\\b\" || true; command -v zfs >/dev/null && zfs list tank/datos || true'"
