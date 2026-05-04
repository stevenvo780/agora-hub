import type { Server } from 'socket.io';
import {
  workersByWorkspace,
  type WorkerRuntimeMetrics
} from './state';

const HEARTBEAT_STALE_MS = Number(process.env.WORKER_HEARTBEAT_STALE_MS || 45_000);
const HEARTBEAT_CHECK_MS = Number(process.env.WORKER_HEARTBEAT_CHECK_MS || 15_000);

export function normalizeWorkerMetrics(payload: unknown): WorkerRuntimeMetrics {
  const input = typeof payload === 'object' && payload !== null
    ? payload as Record<string, unknown>
    : {};
  return {
    activeSessions: typeof input.activeSessions === 'number' ? input.activeSessions : undefined,
    syncLagMs: typeof input.syncLagMs === 'number' ? input.syncLagMs : null,
    lastOperationAt: typeof input.lastOperationAt === 'number' ? input.lastOperationAt : null,
    consecutiveErrors: typeof input.consecutiveErrors === 'number' ? input.consecutiveErrors : undefined,
    version: typeof input.version === 'string' ? input.version : undefined
  };
}

export function recordWorkerHeartbeat(workspaceId: string, payload: unknown, now = Date.now()): boolean {
  const worker = workersByWorkspace.get(workspaceId);
  if (!worker) return false;
  worker.lastHeartbeatAt = now;
  worker.metrics = normalizeWorkerMetrics(payload);
  return true;
}

export function cleanupStaleWorkers(now = Date.now(), staleMs = HEARTBEAT_STALE_MS): number {
  let disconnected = 0;
  for (const [workspaceId, worker] of workersByWorkspace.entries()) {
    if (!worker.socket.connected) continue;
    if (now - worker.lastHeartbeatAt <= staleMs) continue;
    worker.socket.disconnect(true);
    disconnected++;
    console.warn(`[Hub] Worker heartbeat stale for ${workspaceId}; disconnect requested`);
  }
  return disconnected;
}

export function startWorkerHeartbeatMonitor(_io: Server): NodeJS.Timeout {
  return setInterval(() => {
    cleanupStaleWorkers();
  }, HEARTBEAT_CHECK_MS);
}
