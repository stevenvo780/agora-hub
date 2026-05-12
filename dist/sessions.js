"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyWorkspaceStatus = exports.endSessionsByWorker = exports.endSession = exports.notifyWorkspaceSessions = exports.getWorkspaceSessions = void 0;
const state_1 = require("./state");
/** List sessions for a workspace (for broadcasting to subscribers). */
const getWorkspaceSessions = (workspaceId) => (Array.from(state_1.sessions.entries())
    .filter(([, session]) => session.workspaceId === workspaceId)
    .map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.workspaceId,
    workspaceType: session.workspaceType,
    ownerUid: session.ownerUid,
    sessionName: session.sessionName
})));
exports.getWorkspaceSessions = getWorkspaceSessions;
/** Broadcast session list update to all subscribers of a workspace room. */
const notifyWorkspaceSessions = (io, workspaceId) => {
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
    io.to(`workspace:${workspaceId}`).emit('workspace-sessions', {
        workspaceId,
        sessions: activeSessions
    });
};
exports.notifyWorkspaceSessions = notifyWorkspaceSessions;
/** End a single session, clean up reverse index, and notify. */
const endSession = (io, sessionId, reason) => {
    const session = state_1.sessions.get(sessionId);
    if (!session)
        return;
    const workspaceId = session.workspaceId;
    state_1.sessions.delete(sessionId);
    const workerSessions = state_1.sessionsByWorker.get(session.workerSocketId);
    if (workerSessions) {
        workerSessions.delete(sessionId);
        if (workerSessions.size === 0)
            state_1.sessionsByWorker.delete(session.workerSocketId);
    }
    io.to(sessionId).emit('session-ended', { sessionId, reason });
    (0, exports.notifyWorkspaceSessions)(io, workspaceId);
};
exports.endSession = endSession;
/** End all sessions for a given worker. */
const endSessionsByWorker = (io, workerSocketId, reason) => {
    const workerSessions = state_1.sessionsByWorker.get(workerSocketId);
    if (!workerSessions)
        return;
    for (const sessionId of [...workerSessions]) {
        (0, exports.endSession)(io, sessionId, reason);
    }
};
exports.endSessionsByWorker = endSessionsByWorker;
/** Debounced worker status broadcast: immediate for 'online', delayed for 'offline'. */
const notifyWorkspaceStatus = (io, workspaceId, status) => {
    const pending = state_1.pendingStatusNotifications.get(workspaceId);
    if (pending) {
        clearTimeout(pending);
        state_1.pendingStatusNotifications.delete(workspaceId);
    }
    if (status === 'online') {
        console.log(`[Hub] Broadcasting worker-status: ${status} for workspace: ${workspaceId}`);
        io.to(`workspace:${workspaceId}`).emit('worker-status', { status, workspaceId });
    }
    else {
        const timeout = setTimeout(() => {
            const worker = state_1.workersByWorkspace.get(workspaceId);
            if (!worker) {
                console.log(`[Hub] Broadcasting worker-status: offline for workspace: ${workspaceId} (confirmed)`);
                io.to(`workspace:${workspaceId}`).emit('worker-status', { status: 'offline', workspaceId });
            }
            else {
                console.log(`[Hub] Skipping offline notification - worker reconnected for: ${workspaceId}`);
            }
            state_1.pendingStatusNotifications.delete(workspaceId);
        }, state_1.STATUS_DEBOUNCE_MS);
        state_1.pendingStatusNotifications.set(workspaceId, timeout);
    }
};
exports.notifyWorkspaceStatus = notifyWorkspaceStatus;
