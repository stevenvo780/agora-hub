# AgoraHub

Servicio `socket.io` que coordina browser clients, workers de terminal y comandos del agente. Corre como systemd unit `edu-hub.service` (usuario no-root `edu-hub`) en el VPS Hostinger `agora-storage` (`root@76.13.118.239`, dominio `hub.elenxos.com`).

Caddy delante del 3010 con `protocols h1` only (engine.io tiene
problemas con HTTP/2 mid-stream). El firewall raw 3010 está cerrado:
solo 443 acepta tráfico externo.

> **Migración 2026-05**: el hub vivía como `systemd --user` en
> `humanizar2`. Hoy corre en el VPS Hostinger `agora-storage`
> (76.13.118.239) con user no-root + Caddy + ProtectSystem.
> Los workers corren en `ils-server` (100.98.245.50) y apuntan al hub vía
> `NEXUS_URL=https://hub.elenxos.com`.

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

Internamente: copia `dist/index.js` a `76.13.118.239:/opt/edu-hub/dist/`
(usuario `edu-hub`) y reinicia `sudo systemctl restart edu-hub`.

Health pública: `curl https://hub.elenxos.com/health`.
Health local en el VPS: `curl http://127.0.0.1:3010/health`.

```bash
# Acceso al VPS
ssh root@76.13.118.239

# Restart manual
ssh root@76.13.118.239 'systemctl restart edu-hub'

# Logs en vivo
ssh root@76.13.118.239 'journalctl -u edu-hub -f'
```

## Observabilidad

Systemd journal en agora-storage. Caddy access logs en el VPS.
