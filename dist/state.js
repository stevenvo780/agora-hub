"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_HISTORY_BUFFER = exports.STATUS_DEBOUNCE_MS = exports.pendingStatusNotifications = exports.pendingAgentCommands = exports.sessionsByWorker = exports.sessions = exports.workersByWorkspace = void 0;
// ── In-memory state ──────────────────────────────────────────────
exports.workersByWorkspace = new Map();
exports.sessions = new Map();
/** Reverse index: workerSocketId → Set<sessionId> for O(1) lookup on worker disconnect */
exports.sessionsByWorker = new Map();
exports.pendingAgentCommands = new Map();
exports.pendingStatusNotifications = new Map();
// ── Constants ────────────────────────────────────────────────────
exports.STATUS_DEBOUNCE_MS = 2000;
exports.MAX_HISTORY_BUFFER = 500000; // 500KB buffer per session
