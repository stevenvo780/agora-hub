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
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuthMiddleware = registerAuthMiddleware;
exports.registerConnectionHandlers = registerConnectionHandlers;
const admin = __importStar(require("firebase-admin"));
const workerToken_1 = require("./lib/workerToken");
const state_1 = require("./state");
const auth_1 = require("./auth");
const sessions_1 = require("./sessions");
const agentCommands_1 = require("./agentCommands");
const workers_1 = require("./workers");
/** Register socket.io middleware for authentication. */
function registerAuthMiddleware(io) {
    io.use(async (socket, next) => {
        const { type, token, workerToken } = socket.handshake.auth;
        try {
            if (type === 'client') {
                if (!token)
                    return next(new Error('Missing client token'));
                try {
                    const decodedToken = await admin.auth().verifyIdToken(token);
                    socket.data.uid = decodedToken.uid;
                    console.log(`✅ Client authenticated: ${decodedToken.uid}`);
                    if (socket.handshake.auth.sessionId) {
                        socket.data.requestedSessionId = socket.handshake.auth.sessionId;
                    }
                }
                catch (e) {
                    console.error('Token verification failed:', e);
                    return next(new Error('Authentication failed'));
                }
                socket.data.role = 'client';
                return next();
            }
            if (type === 'worker') {
                if (!workerToken)
                    return next(new Error('Missing worker token'));
                const payload = (0, auth_1.verifyWorkerToken)(workerToken);
                if (!payload) {
                    console.warn(`⚠️ Invalid worker token signature`);
                    return next(new Error('Unauthorized: Invalid token'));
                }
                const { workspaceId, workspaceType, ownerId } = payload;
                socket.data.workspaceId = workspaceId;
                socket.data.workspaceType = workspaceType;
                socket.data.ownerId = ownerId;
                socket.data.role = 'worker';
                return next();
            }
            if (type === 'sync-agent') {
                if (!workerToken)
                    return next(new Error('Missing worker token for sync-agent'));
                const payload = (0, auth_1.verifyWorkerToken)(workerToken);
                if (!payload) {
                    console.warn(`⚠️ Blocked unauthorized sync-agent connection (Invalid Token)`);
                    return next(new Error('Unauthorized: Invalid token'));
                }
                const { workspaceId, workspaceType, ownerId } = payload;
                socket.data.workspaceId = workspaceId;
                socket.data.workspaceType = workspaceType;
                socket.data.ownerId = ownerId;
                socket.data.role = 'sync-agent';
                return next();
            }
            return next(new Error('Unknown connection type'));
        }
        catch (e) {
            console.error('Connection error:', e);
            return next(new Error('Internal Server Error'));
        }
    });
}
/** Register all socket.io connection handlers (worker, sync-agent, client). */
function registerConnectionHandlers(io) {
    io.on('connection', (socket) => {
        const role = socket.data.role;
        if (role === 'worker') {
            handleWorkerConnection(io, socket);
        }
        if (role === 'sync-agent') {
            handleSyncAgentConnection(io, socket);
        }
        if (role === 'client') {
            handleClientConnection(io, socket);
        }
    });
}
// ── Worker handler ───────────────────────────────────────────────
function handleWorkerConnection(io, socket) {
    const workspaceId = socket.data.workspaceId;
    const workspaceType = socket.data.workspaceType;
    const ownerId = socket.data.ownerId;
    const existing = state_1.workersByWorkspace.get(workspaceId);
    if (existing) {
        if (existing.socket.connected) {
            console.log(`⚠️ Worker already connected for workspace ${workspaceId}, rejecting duplicate`);
            socket.emit('error', { message: 'Worker already connected for this workspace' });
            socket.disconnect(true);
            return;
        }
        console.log(`🔄 Cleaning up stale worker for workspace ${workspaceId}`);
        (0, sessions_1.endSessionsByWorker)(io, existing.socketId, 'worker-replaced');
    }
    state_1.workersByWorkspace.set(workspaceId, {
        socketId: socket.id,
        socket,
        workspaceType,
        ownerId,
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now()
    });
    console.log(`✅ Worker registered for Workspace: ${workspaceId} [Type: ${workspaceType}]`);
    (0, sessions_1.notifyWorkspaceStatus)(io, workspaceId, 'online');
    socket.on('disconnect', () => {
        const current = state_1.workersByWorkspace.get(workspaceId);
        if (current?.socketId === socket.id) {
            state_1.workersByWorkspace.delete(workspaceId);
            (0, sessions_1.endSessionsByWorker)(io, socket.id, 'worker-disconnected');
            (0, agentCommands_1.rejectPendingAgentCommandsForWorker)(socket.id, 'Worker disconnected before command result');
            (0, sessions_1.notifyWorkspaceStatus)(io, workspaceId, 'offline');
            console.log(`❌ Worker disconnected for Workspace: ${workspaceId}`);
        }
    });
    socket.on('worker-heartbeat', (payload) => {
        (0, workers_1.recordWorkerHeartbeat)(workspaceId, payload);
    });
    socket.on('output', (payload) => {
        const session = state_1.sessions.get(payload.sessionId);
        if (!session || session.workerSocketId !== socket.id)
            return;
        const data = payload.output || payload.data || '';
        // Buffer output for history replay (ring buffer to avoid GC pressure)
        session.outputChunks.push(data);
        session.outputSize += data.length;
        while (session.outputSize > state_1.MAX_HISTORY_BUFFER) {
            const removed = session.outputChunks.shift();
            session.outputSize -= removed.length;
        }
        io.to(payload.sessionId).emit('output', {
            sessionId: payload.sessionId,
            data
        });
    });
    socket.on('session-ended', (payload) => {
        const session = state_1.sessions.get(payload.sessionId);
        if (session && session.workerSocketId === socket.id) {
            (0, sessions_1.endSession)(io, payload.sessionId, payload.reason);
        }
    });
    socket.on('agent-command-result', (payload) => {
        (0, agentCommands_1.resolvePendingAgentCommandResult)(payload, socket.id, workspaceId);
    });
}
// ── Sync-agent handler ───────────────────────────────────────────
function handleSyncAgentConnection(io, socket) {
    const workspaceId = socket.data.workspaceId;
    const workspaceType = socket.data.workspaceType;
    const ownerId = socket.data.ownerId;
    console.log(`📁 Sync-Agent connected for Workspace: ${workspaceId} (Socket: ${socket.id})`);
    // Helper: mint and send a Firebase custom token to the sync-agent
    const mintAndSendToken = async () => {
        try {
            let uidToMint = '';
            let additionalClaims = {};
            if (workspaceType === 'personal' && ownerId) {
                uidToMint = ownerId;
                additionalClaims = { workspaceId, role: 'sync-agent' };
            }
            else {
                uidToMint = `sync-agent:${workspaceId}`;
                additionalClaims = { workspaceId, role: 'sync-agent' };
            }
            const token = await admin.auth().createCustomToken(uidToMint, additionalClaims);
            socket.emit('firebase-custom-token', { token });
            console.log(`🔑 Sent custom token to sync-agent for ${uidToMint}`);
        }
        catch (e) {
            console.error('Error minting token for sync-agent:', e);
        }
    };
    void mintAndSendToken();
    socket.on('request-firebase-token', () => {
        console.log(`🔑 Sync-Agent requesting token refresh for ${workspaceId}`);
        void mintAndSendToken();
    });
    socket.on('doc-change', (payload) => {
        const roomName = `workspace:${payload.workspaceId}`;
        console.log(`[Hub] doc-change: ${payload.action} ${payload.docId} in ${payload.workspaceId}`);
        io.to(roomName).emit('doc-change', payload);
    });
    socket.on('disconnect', () => {
        console.log(`📁 Sync-Agent disconnected for Workspace: ${workspaceId}`);
    });
}
// ── Client handler ───────────────────────────────────────────────
function handleClientConnection(io, socket) {
    const uid = socket.data.uid;
    console.log(`👤 Client connected: ${uid} (Socket: ${socket.id})`);
    if (socket.data.requestedSessionId) {
        void (async () => {
            const session = state_1.sessions.get(socket.data.requestedSessionId);
            if (!session)
                return;
            const allowed = await (0, auth_1.canUserAccessSession)(session, uid);
            if (!allowed)
                return;
            console.log(`🔄 Restoring session ${socket.data.requestedSessionId} for user ${uid}`);
            await socket.join(socket.data.requestedSessionId);
            socket.emit('session-created', {
                id: socket.data.requestedSessionId,
                workspaceId: session.workspaceId,
                workspaceName: session.workspaceName,
                workspaceType: session.workspaceType,
                sessionName: session.sessionName
            });
        })();
    }
    socket.on('workspace:subscribe', async (data) => {
        const { workspaceId } = data;
        if (!workspaceId || !(await (0, auth_1.canUserAccessWorkspace)(workspaceId, uid))) {
            socket.emit('error', { message: 'No autorizado para este espacio', workspaceId });
            return;
        }
        const roomName = `workspace:${workspaceId}`;
        await socket.join(roomName);
        console.log(`[Hub] Client ${uid} subscribed to ${roomName}`);
        const worker = state_1.workersByWorkspace.get(workspaceId);
        socket.emit('worker-status', {
            status: worker ? 'online' : 'offline',
            workspaceId
        });
        const activeSessions = Array.from(state_1.sessions.entries())
            .filter(([, s]) => s.workspaceId === workspaceId)
            .map(([id, s]) => ({
            id,
            workspaceId: s.workspaceId,
            workspaceName: s.workspaceName,
            workspaceType: s.workspaceType,
            ownerUid: s.ownerUid,
            sessionName: s.sessionName
        }));
        socket.emit('workspace-sessions', {
            workspaceId,
            sessions: activeSessions
        });
    });
    socket.on('workspace:unsubscribe', async (data) => {
        const { workspaceId } = data;
        const roomName = `workspace:${workspaceId}`;
        await socket.leave(roomName);
        console.log(`[Hub] Client ${uid} unsubscribed from ${roomName}`);
    });
    socket.on('workspace:check-worker', async (data) => {
        const { workspaceId } = data;
        if (!workspaceId || !(await (0, auth_1.canUserAccessWorkspace)(workspaceId, uid))) {
            socket.emit('error', { message: 'No autorizado para este espacio', workspaceId });
            return;
        }
        const worker = state_1.workersByWorkspace.get(workspaceId);
        socket.emit('worker-status', {
            status: worker ? 'online' : 'offline',
            workspaceId
        });
    });
    socket.on('restore-session', async (payload) => {
        const sessionId = payload?.sessionId;
        if (!sessionId)
            return;
        const session = state_1.sessions.get(sessionId);
        if (!session) {
            socket.emit('restore-failed', { sessionId, reason: 'session-not-found' });
            return;
        }
        const allowed = await (0, auth_1.canUserAccessSession)(session, uid);
        if (!allowed) {
            socket.emit('restore-failed', { sessionId, reason: 'unauthorized' });
            return;
        }
        await socket.join(sessionId);
        socket.emit('session-created', {
            id: sessionId,
            workspaceId: session.workspaceId,
            workspaceName: session.workspaceName,
            workspaceType: session.workspaceType,
            sessionName: session.sessionName
        });
        if (session.outputChunks.length > 0) {
            socket.emit('output', {
                sessionId,
                data: session.outputChunks.join('')
            });
        }
    });
    socket.on('join-session', async (payload) => {
        const { sessionId } = payload;
        if (!sessionId)
            return;
        const session = state_1.sessions.get(sessionId);
        if (!session) {
            socket.emit('join-session-failed', { sessionId, reason: 'session-not-found' });
            return;
        }
        const isOwner = session.ownerUid === uid;
        const allowed = await (0, auth_1.canUserAccessSession)(session, uid);
        if (!allowed) {
            socket.emit('join-session-failed', { sessionId, reason: 'unauthorized' });
            return;
        }
        await socket.join(sessionId);
        console.log(`[Hub] Client ${uid} joined session ${sessionId} (owner: ${isOwner})`);
        socket.emit('session-joined', {
            id: sessionId,
            workspaceId: session.workspaceId,
            workspaceName: session.workspaceName,
            workspaceType: session.workspaceType,
            sessionName: session.sessionName,
            isOwner
        });
        if (session.outputChunks.length > 0) {
            socket.emit('output', {
                sessionId,
                data: session.outputChunks.join('')
            });
        }
    });
    socket.on('create-session', async (payload) => {
        const { workspaceId, workspaceName, sessionName } = payload;
        console.log(`[Hub] create-session request from ${uid} for workspace ${workspaceId}`);
        if (!workspaceId || !(await (0, auth_1.canUserAccessWorkspace)(workspaceId, uid))) {
            return socket.emit('error', {
                message: 'No autorizado para este espacio de trabajo',
                workspaceId
            });
        }
        const worker = state_1.workersByWorkspace.get(workspaceId);
        if (!worker) {
            console.log(`[Hub] No worker found for workspace ${workspaceId}`);
            return socket.emit('error', {
                message: `No hay worker conectado para este espacio de trabajo`,
                workspaceId
            });
        }
        const sessionId = `sess_${workspaceId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
        state_1.sessions.set(sessionId, {
            ownerUid: uid,
            workerSocketId: worker.socketId,
            workspaceId,
            workspaceName,
            workspaceType: (0, workerToken_1.getWorkspaceTypeFromId)(workspaceId),
            sessionName: sessionName || undefined,
            outputChunks: [],
            outputSize: 0
        });
        // Maintain reverse index
        const workerSessions = state_1.sessionsByWorker.get(worker.socketId) ?? new Set();
        workerSessions.add(sessionId);
        state_1.sessionsByWorker.set(worker.socketId, workerSessions);
        await socket.join(sessionId);
        io.to(worker.socketId).emit('session-created', {
            id: sessionId,
            workspaceId,
            workspaceName,
            workspaceType: (0, workerToken_1.getWorkspaceTypeFromId)(workspaceId)
        });
        socket.emit('session-created', {
            id: sessionId,
            workspaceId,
            sessionName: sessionName || undefined
        });
        (0, sessions_1.notifyWorkspaceSessions)(io, workspaceId);
        console.log(`[Hub] Session created: ${sessionId} for workspace ${workspaceId}`);
    });
    socket.on('rename-session', async (payload) => {
        const { sessionId, sessionName } = payload;
        const session = state_1.sessions.get(sessionId);
        if (!session)
            return;
        const isOwner = session.ownerUid === uid;
        const canCollaborate = session.workspaceType === 'shared'
            && socket.rooms.has(sessionId)
            && await (0, auth_1.canUserAccessSession)(session, uid);
        if (!isOwner && !canCollaborate)
            return;
        session.sessionName = sessionName;
        console.log(`[Hub] Session renamed: ${sessionId} -> "${sessionName}" by ${uid}`);
        io.to(`workspace:${session.workspaceId}`).emit('session-renamed', {
            sessionId,
            sessionName
        });
    });
    socket.on('execute', async (data) => {
        const session = state_1.sessions.get(data.sessionId);
        if (!session)
            return;
        const isOwner = session.ownerUid === uid;
        const canCollaborate = session.workspaceType === 'shared'
            && socket.rooms.has(data.sessionId)
            && await (0, auth_1.canUserAccessSession)(session, uid);
        if (!isOwner && !canCollaborate)
            return;
        io.to(session.workerSocketId).emit('execute', {
            sessionId: data.sessionId,
            command: data.command
        });
    });
    socket.on('resize', (data) => {
        const session = state_1.sessions.get(data.sessionId);
        if (!session)
            return;
        if (session.ownerUid !== uid)
            return;
        io.to(session.workerSocketId).emit('resize', {
            sessionId: data.sessionId,
            cols: data.cols,
            rows: data.rows
        });
    });
    socket.on('kill-session', (data) => {
        const session = state_1.sessions.get(data.sessionId);
        if (!session || session.ownerUid !== uid)
            return;
        io.to(session.workerSocketId).emit('kill-session', { sessionId: data.sessionId });
        (0, sessions_1.endSession)(io, data.sessionId, 'user-terminated');
    });
    socket.on('disconnect', () => {
        console.log(`👤 Client disconnected: ${uid}`);
    });
}
