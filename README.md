# AgoraHub

Servicio `socket.io` que coordina browser clients, workers de terminal y comandos del agente.

## Setup local

```bash
npm install
npm run typecheck
npm test
npm run build
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
