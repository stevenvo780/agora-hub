# AgoraHub

Servicio `socket.io` que coordina browser clients, workers de terminal y comandos del agente. Corre como systemd unit `edu-hub.service` (usuario no-root `edu-hub`) en la VM GCP Compute Engine `agora-hub` (e2-micro free tier, us-central1-a, IP `34.72.204.171`, dominio `hub.humanizar-dev.cloud`).

Caddy delante del 3010 con `protocols h1` only (engine.io tiene
problemas con HTTP/2 mid-stream). El firewall raw 3010 está cerrado:
solo 443 acepta tráfico externo.

> **Migración 2026-05**: el hub vivía como `systemd --user` en
> `humanizar2`. Hoy corre en VM dedicada GCP e2-micro free tier
> (~$0/mes) con user no-root + ProtectSystem + apt cron weekly.
> Los workers siguen en `humanizar2` y apuntan al hub vía
> `NEXUS_URL=https://hub.humanizar-dev.cloud`.

> **Operación / restart**: ver [`../RUNBOOK_OPS.md §2`](../RUNBOOK_OPS.md). El state en memoria SE PIERDE en restart — clientes reconectan solos.
> **Detalle arquitectura/secrets**: `../CLAUDE.md` (raíz workspace).

## Setup local

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev    # arranca con tsx en :3010 (o el PORT configurado)
```

Variables principales:

- `WORKER_SOCKET_SECRET`: requerido para nuevos despliegues; firma tokens socket de workers.
- `WORKER_SECRET`: fallback legacy mientras se completa la rotación.
- `WORKER_SECRET_PREVIOUS`: secreto anterior aceptado temporalmente durante rotación.
- `CLIENT_ORIGIN`: allowlist CORS separada por comas.
- `PORT`: puerto HTTP, default derivado de `NEXUS_URL` o `3002`.
- `FIREBASE_SERVICE_ACCOUNT` o `GOOGLE_APPLICATION_CREDENTIALS`: credenciales admin Firebase.
- `ALLOW_LEGACY_WORKER_TOKENS`: solo compatibilidad temporal.
- `WORKER_HEARTBEAT_STALE_MS`: timeout app-level de heartbeat worker.

## Operación

- `GET /health`: health liviano.
- `GET /agent/workspace-status`: estado de worker/sesiones para el agente.
- `POST /agent/run-command`: envía comando confirmado al worker, con rate limit por workspace.
- `GET /status`: estado administrativo protegido por Firebase admin role.

Cuando Hub reinicia se pierde el estado en memoria: sockets, sesiones PTY y comandos pendientes. El browser debe reconectar, re-suscribirse a `workspace:<id>` y crear/restaurar sesiones si siguen existiendo. Los comandos agente pendientes fallan y deben reintentarse desde el agente con un nuevo `requestId`.

## Despliegue

Desde `AgoraWorker/desplieges-prod/`:

```bash
cd ../AgoraHub
npm run build                       # genera dist/index.js
cd ../AgoraWorker/desplieges-prod
./deploy_hub.sh                     # scp dist + systemctl restart edu-hub
```

Internamente: copia `dist/index.js` a `agora-hub:/opt/edu-hub/dist/`
(usuario `edu-hub`) y reinicia `sudo systemctl restart edu-hub`.

Health pública: `curl https://hub.humanizar-dev.cloud/health`.
Health local en la VM: `curl http://127.0.0.1:3010/health`.

```bash
# Acceso a la VM
gcloud compute ssh agora-hub --zone=us-central1-a

# Restart manual
gcloud compute ssh agora-hub --zone=us-central1-a --command='sudo systemctl restart edu-hub'

# Logs en vivo
gcloud compute ssh agora-hub --zone=us-central1-a --command='journalctl -u edu-hub -f'
```

## Observabilidad

Cloud Ops Agent v2.66 instalado en la VM. Dos dashboards Cloud
Monitoring + 4 alerting policies (email a `stevenvallejo780@gmail.com`)
configuradas para CPU/memoria, hub health, restart count y error rate.
