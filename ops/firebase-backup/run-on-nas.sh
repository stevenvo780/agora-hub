#!/usr/bin/env bash
# Run the firebase-backup against a NAS destination, using the serviceAccountKey
# pulled from stev-server. The key is copied to a tmpfs path on the NAS only
# for the duration of the run and removed at exit.
#
# Requirements (on the NAS):
#   - Docker
#   - Network reachability to firestore.googleapis.com, storage.googleapis.com,
#     and the RTDB host
#
# Requirements (on the workstation running this script):
#   - SSH access to nass-stev and stev-server (key-based)
set -euo pipefail

NAS_HOST=${NAS_HOST:-nass-stev}
HUB_HOST=${HUB_HOST:-stev-server}
HUB_SA_PATH=${HUB_SA_PATH:-/home/stev/edu-hub/serviceAccountKey.json}
NAS_BACKUP_ROOT=${NAS_BACKUP_ROOT:-/mnt/pool/backups/agora}
NAS_MIRROR_ROOT=${NAS_MIRROR_ROOT:-/mnt/pool/datos/agora/backups-mirror}
RUN_ID=${RUN_ID:-firebase-$(date -u +%Y%m%dT%H%M%SZ)}
PROJECT_ID=${PROJECT_ID:-udea-filosofia}
STORAGE_BUCKET=${STORAGE_BUCKET:-udea-filosofia.firebasestorage.app}
RTDB_URL=${RTDB_URL:-https://udea-filosofia-default-rtdb.firebaseio.com}
NODE_IMAGE=${NODE_IMAGE:-node:20-slim}

LOCAL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "[1/6] Verifying connectivity..."
ssh "$NAS_HOST" 'docker version >/dev/null && echo "  nas docker OK"'
ssh "$HUB_HOST" "test -f $HUB_SA_PATH && echo '  stev sa OK'"

echo "[2/6] Preparing destination on NAS..."
ssh "$NAS_HOST" "mkdir -p '$NAS_BACKUP_ROOT/$RUN_ID' '$NAS_MIRROR_ROOT'"

echo "[3/6] Copying backup script to NAS..."
ssh "$NAS_HOST" "mkdir -p ~/.agora-tmp/firebase-backup && chmod 700 ~/.agora-tmp"
scp -q "$LOCAL_DIR/backup.mjs" "$LOCAL_DIR/package.json" "$NAS_HOST:~/.agora-tmp/firebase-backup/"

echo "[4/6] Streaming serviceAccountKey from stev-server to NAS (tmpfs path)..."
# Read on stev → write on nas, never touches workstation disk
ssh "$HUB_HOST" "cat $HUB_SA_PATH" \
  | ssh "$NAS_HOST" "umask 077; cat > ~/.agora-tmp/firebase-backup/sa.json"

echo "[5/6] Running backup container (this can take a while)..."
ssh "$NAS_HOST" "
  set -e
  cd ~/.agora-tmp/firebase-backup
  docker run --rm \
    -v \"$NAS_BACKUP_ROOT/$RUN_ID\":/dest \
    -v \"\$PWD/sa.json\":/sa.json:ro \
    -v \"\$PWD\":/work \
    -w /work \
    -e BACKUP_DEST=/dest \
    -e RUN_ID='$RUN_ID' \
    -e FIREBASE_PROJECT_ID='$PROJECT_ID' \
    -e FIREBASE_STORAGE_BUCKET='$STORAGE_BUCKET' \
    -e FIREBASE_DATABASE_URL='$RTDB_URL' \
    -e GOOGLE_APPLICATION_CREDENTIALS=/sa.json \
    --network host \
    '$NODE_IMAGE' \
    bash -lc 'npm install --no-audit --no-fund --omit=dev --silent && node backup.mjs'
"

echo "[6/6] Mirroring to second dataset (tank/datos) and removing temp credentials..."
ssh "$NAS_HOST" "
  set -e
  rsync -a --delete '$NAS_BACKUP_ROOT/$RUN_ID/' '$NAS_MIRROR_ROOT/$RUN_ID/'
  rm -f ~/.agora-tmp/firebase-backup/sa.json
  echo 'Backup primary: $NAS_BACKUP_ROOT/$RUN_ID'
  echo 'Backup mirror : $NAS_MIRROR_ROOT/$RUN_ID'
  du -sh '$NAS_BACKUP_ROOT/$RUN_ID' '$NAS_MIRROR_ROOT/$RUN_ID' 2>&1 || true
"

echo "DONE."
