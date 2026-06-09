"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const express_1 = __importDefault(require("express"));
const workerToken_1 = require("./lib/workerToken");
const rateLimit_1 = require("./lib/rateLimit");
const state_1 = require("./state");
const auth_1 = require("./auth");
const sessions_1 = require("./sessions");
const agentCommands_1 = require("./agentCommands");
const gitCommit_1 = require("./lib/gitCommit");
const crypto_1 = require("crypto");
const HUB_INTERNAL_SECRET = (process.env.HUB_INTERNAL_SECRET || process.env.BACKEND_INTERNAL_SECRET || '').trim();
const safeEq = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && (0, crypto_1.timingSafeEqual)(x, y);
};
// ── Rate limiting ────────────────────────────────────────────────
const AGENT_CMD_WINDOW_MS = 30000;
const AGENT_CMD_MAX_PER_WINDOW = 8;
const agentCommandRateLimiter = (0, rateLimit_1.createSlidingWindowRateLimiter)({
    windowMs: AGENT_CMD_WINDOW_MS,
    maxPerWindow: AGENT_CMD_MAX_PER_WINDOW
});
function checkAgentCommandRateLimit(workspaceId) {
    return agentCommandRateLimiter.check(workspaceId);
}
// ── Route registration ───────────────────────────────────────────
function registerRoutes(app, io) {
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString(), gitCommit: (0, gitCommit_1.isGitCommitConfigured)() });
    });
    // Commit del workspace EN EL VPS: AgoraBack (Cloud Run, RAM limitada) manda la
    // lista de archivos (metadata); el Hub lee los blobs de MinIO local + pushea a
    // Forgejo local. Mueve el buffering del body grande fuera de Cloud Run (sin
    // OOM, sin egress). Auth: HUB_INTERNAL_SECRET (server-to-server, no usuario).
    app.post('/internal/git-commit', express_1.default.json({ limit: '80mb' }), async (req, res) => {
        const provided = req.headers['x-hub-internal-secret']
            || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!HUB_INTERNAL_SECRET || !provided || !safeEq(provided, HUB_INTERNAL_SECRET)) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        if (!(0, gitCommit_1.isGitCommitConfigured)()) {
            return res.status(503).json({ ok: false, error: 'git-commit no configurado (faltan NAS_S3_*/FORGEJO_*)' });
        }
        try {
            const result = await (0, gitCommit_1.hubGitCommit)(req.body);
            return res.status(result.ok ? 200 : 502).json(result);
        }
        catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.get('/agent/workspace-status', async (req, res) => {
        const decoded = await (0, auth_1.authenticateHttpUser)(req, res);
        if (!decoded)
            return;
        const workspaceId = String(req.query.workspaceId || '');
        if (!workspaceId || !(await (0, auth_1.canUserAccessWorkspace)(workspaceId, decoded.uid))) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const worker = state_1.workersByWorkspace.get(workspaceId);
        res.json({
            workspaceId,
            worker: worker
                ? {
                    online: worker.socket.connected,
                    socketId: worker.socketId,
                    workspaceType: worker.workspaceType,
                    ownerId: worker.ownerId || null,
                    connectedAt: worker.connectedAt,
                    lastHeartbeatAt: worker.lastHeartbeatAt,
                    metrics: worker.metrics ?? null
                }
                : {
                    online: false,
                    socketId: null,
                    workspaceType: (0, workerToken_1.getWorkspaceTypeFromId)(workspaceId),
                    ownerId: (0, workerToken_1.getPersonalWorkspaceOwnerId)(workspaceId)
                },
            sessions: (0, sessions_1.getWorkspaceSessions)(workspaceId)
        });
    });
    app.post('/agent/run-command', async (req, res) => {
        const decoded = await (0, auth_1.authenticateHttpUser)(req, res);
        if (!decoded)
            return;
        const workspaceId = String(req.body?.workspaceId || '');
        const command = String(req.body?.command || '');
        const cwd = String(req.body?.cwd || '.');
        const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs || 15000), 1000), 25000);
        const maxOutputBytes = Math.min(Math.max(Number(req.body?.maxOutputBytes || 12000), 1000), 20000);
        if (!workspaceId || !(await (0, auth_1.canUserAccessWorkspace)(workspaceId, decoded.uid))) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const rl = checkAgentCommandRateLimit(workspaceId);
        if (!rl.ok) {
            res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).json({
                error: `Rate limit: máximo ${AGENT_CMD_MAX_PER_WINDOW} comandos cada ${AGENT_CMD_WINDOW_MS / 1000}s por workspace.`
            });
        }
        if (!command.trim()) {
            return res.status(400).json({ error: 'command required' });
        }
        const worker = state_1.workersByWorkspace.get(workspaceId);
        if (!worker || !worker.socket.connected) {
            return res.status(409).json({ error: 'No hay worker conectado para este workspace' });
        }
        const requestId = (0, agentCommands_1.makeAgentCommandRequestId)(workspaceId);
        try {
            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    state_1.pendingAgentCommands.delete(requestId);
                    reject(new Error('Timeout esperando resultado del worker'));
                }, timeoutMs + 5000);
                state_1.pendingAgentCommands.set(requestId, {
                    workspaceId,
                    workerSocketId: worker.socketId,
                    resolve,
                    reject,
                    timeout
                });
                io.to(worker.socketId).emit('agent-command', {
                    requestId,
                    workspaceId,
                    command,
                    cwd,
                    timeoutMs,
                    maxOutputBytes
                });
            });
            res.json(result);
        }
        catch (error) {
            const pending = state_1.pendingAgentCommands.get(requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                state_1.pendingAgentCommands.delete(requestId);
            }
            res.status(504).json({ error: error instanceof Error ? error.message : 'Worker command failed' });
        }
    });
    app.get('/status', async (req, res) => {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.split(' ')[1];
        try {
            const decoded = await (await Promise.resolve().then(() => __importStar(require('firebase-admin')))).auth().verifyIdToken(token);
            if (!(await (0, auth_1.isAdminUser)(decoded.uid))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            console.log(`🔎 Status checked by ${decoded.uid}`);
        }
        catch (e) {
            console.warn('Status endpoint auth failed');
            return res.status(403).json({ error: 'Forbidden' });
        }
        const workers = Array.from(state_1.workersByWorkspace.entries()).map(([id, info]) => ({
            workspaceId: id,
            socketId: info.socketId,
            workspaceType: info.workspaceType,
            ownerId: info.ownerId,
            connected: info.socket.connected,
            connectedAt: info.connectedAt,
            lastHeartbeatAt: info.lastHeartbeatAt,
            metrics: info.metrics ?? null
        }));
        const activeSessions = Array.from(state_1.sessions.entries()).map(([id, session]) => ({
            sessionId: id,
            workspaceId: session.workspaceId,
            workspaceType: session.workspaceType,
            ownerUid: session.ownerUid
        }));
        res.json({
            workers,
            sessions: activeSessions,
            totalWorkers: workers.length,
            totalSessions: activeSessions.length
        });
    });
}
