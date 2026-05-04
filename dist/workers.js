"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWorkerMetrics = normalizeWorkerMetrics;
exports.recordWorkerHeartbeat = recordWorkerHeartbeat;
exports.cleanupStaleWorkers = cleanupStaleWorkers;
exports.startWorkerHeartbeatMonitor = startWorkerHeartbeatMonitor;
const state_1 = require("./state");
const HEARTBEAT_STALE_MS = Number(process.env.WORKER_HEARTBEAT_STALE_MS || 45000);
const HEARTBEAT_CHECK_MS = Number(process.env.WORKER_HEARTBEAT_CHECK_MS || 15000);
function normalizeWorkerMetrics(payload) {
    const input = typeof payload === 'object' && payload !== null
        ? payload
        : {};
    return {
        activeSessions: typeof input.activeSessions === 'number' ? input.activeSessions : undefined,
        syncLagMs: typeof input.syncLagMs === 'number' ? input.syncLagMs : null,
        lastOperationAt: typeof input.lastOperationAt === 'number' ? input.lastOperationAt : null,
        consecutiveErrors: typeof input.consecutiveErrors === 'number' ? input.consecutiveErrors : undefined,
        version: typeof input.version === 'string' ? input.version : undefined
    };
}
function recordWorkerHeartbeat(workspaceId, payload, now = Date.now()) {
    const worker = state_1.workersByWorkspace.get(workspaceId);
    if (!worker)
        return false;
    worker.lastHeartbeatAt = now;
    worker.metrics = normalizeWorkerMetrics(payload);
    return true;
}
function cleanupStaleWorkers(now = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
    let disconnected = 0;
    for (const [workspaceId, worker] of state_1.workersByWorkspace.entries()) {
        if (!worker.socket.connected)
            continue;
        if (now - worker.lastHeartbeatAt <= staleMs)
            continue;
        worker.socket.disconnect(true);
        disconnected++;
        console.warn(`[Hub] Worker heartbeat stale for ${workspaceId}; disconnect requested`);
    }
    return disconnected;
}
function startWorkerHeartbeatMonitor(_io) {
    return setInterval(() => {
        cleanupStaleWorkers();
    }, HEARTBEAT_CHECK_MS);
}
