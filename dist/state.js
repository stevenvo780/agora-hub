"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_HISTORY_BUFFER = exports.WORKER_DISCONNECT_GRACE_MS = exports.STATUS_DEBOUNCE_MS = exports.workerDisconnectGrace = exports.pendingStatusNotifications = exports.pendingAgentCommands = exports.sessionsByWorker = exports.sessions = exports.workersByWorkspace = void 0;
// ── In-memory state ──────────────────────────────────────────────
exports.workersByWorkspace = new Map();
exports.sessions = new Map();
/** Reverse index: workerSocketId → Set<sessionId> for O(1) lookup on worker disconnect */
exports.sessionsByWorker = new Map();
exports.pendingAgentCommands = new Map();
exports.pendingStatusNotifications = new Map();
/** workspaceId → timer de gracia. Al caerse un worker NO terminamos sus sesiones
 *  de inmediato: su PTY sigue vivo. Damos una ventana para que reconecte y
 *  re-attachee (tipo tmux); sólo si la gracia expira se terminan las sesiones. */
exports.workerDisconnectGrace = new Map();
// ── Constants ────────────────────────────────────────────────────
exports.STATUS_DEBOUNCE_MS = 2000;
exports.WORKER_DISCONNECT_GRACE_MS = 120000; // gracia para reconexión de worker antes de terminar sesiones
exports.MAX_HISTORY_BUFFER = 500000; // 500KB buffer per session
