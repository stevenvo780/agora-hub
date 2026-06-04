import { Server } from 'socket.io';
import {
  sessions,
  sessionsByWorker,
  workersByWorkspace,
  pendingStatusNotifications,
  STATUS_DEBOUNCE_MS
} from './state';

/** List sessions for a workspace (for broadcasting to subscribers). */
export const getWorkspaceSessions = (workspaceId: string) => (
  Array.from(sessions.entries())
    .filter(([, session]) => session.workspaceId === workspaceId)
    .map(([sessionId, session]) => ({
      sessionId,
      workspaceId: session.workspaceId,
      workspaceType: session.workspaceType,
      ownerUid: session.ownerUid,
      sessionName: session.sessionName
    }))
);

/** Broadcast session list update to all subscribers of a workspace room. */
export const notifyWorkspaceSessions = (io: Server, workspaceId: string) => {
  const activeSessions = Array.from(sessions.entries())
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

/** End a single session, clean up reverse index, and notify. */
export const endSession = (io: Server, sessionId: string, reason: string) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const workspaceId = session.workspaceId;
  sessions.delete(sessionId);
  const workerSessions = sessionsByWorker.get(session.workerSocketId);
  if (workerSessions) {
    workerSessions.delete(sessionId);
    if (workerSessions.size === 0) sessionsByWorker.delete(session.workerSocketId);
  }
  io.to(sessionId).emit('session-ended', { sessionId, reason });
  notifyWorkspaceSessions(io, workspaceId);
};

/** End all sessions for a given worker. */
export const endSessionsByWorker = (io: Server, workerSocketId: string, reason: string) => {
  const workerSessions = sessionsByWorker.get(workerSocketId);
  if (!workerSessions) return;
  for (const sessionId of [...workerSessions]) {
    endSession(io, sessionId, reason);
  }
};

/**
 * Re-vincula las sesiones de un worker que reconectó tras un corte de red.
 * Los PTYs siguen vivos en el worker (no se matan al desconectarse), así que sólo
 * hay que re-apuntar el ruteo del viejo socketId al nuevo. Evita que un parpadeo
 * de red mate un agente largo corriendo en la terminal.
 */
export const reattachSessions = (io: Server, oldSocketId: string, newSocketId: string) => {
  const workerSessions = sessionsByWorker.get(oldSocketId);
  if (!workerSessions || workerSessions.size === 0) return 0;
  for (const sessionId of workerSessions) {
    const session = sessions.get(sessionId);
    if (session) {
      session.workerSocketId = newSocketId;
      io.to(sessionId).emit('output', { sessionId, data: '\r\n\x1b[32m[worker reconectado — sesión recuperada]\x1b[0m\r\n' });
    }
  }
  sessionsByWorker.set(newSocketId, new Set(workerSessions));
  sessionsByWorker.delete(oldSocketId);
  return workerSessions.size;
};

/** Debounced worker status broadcast: immediate for 'online', delayed for 'offline'. */
export const notifyWorkspaceStatus = (io: Server, workspaceId: string, status: 'online' | 'offline') => {
  const pending = pendingStatusNotifications.get(workspaceId);
  if (pending) {
    clearTimeout(pending);
    pendingStatusNotifications.delete(workspaceId);
  }

  if (status === 'online') {
    console.log(`[Hub] Broadcasting worker-status: ${status} for workspace: ${workspaceId}`);
    io.to(`workspace:${workspaceId}`).emit('worker-status', { status, workspaceId });
  } else {
    const timeout = setTimeout(() => {
      const worker = workersByWorkspace.get(workspaceId);
      if (!worker) {
        console.log(`[Hub] Broadcasting worker-status: offline for workspace: ${workspaceId} (confirmed)`);
        io.to(`workspace:${workspaceId}`).emit('worker-status', { status: 'offline', workspaceId });
      } else {
        console.log(`[Hub] Skipping offline notification - worker reconnected for: ${workspaceId}`);
      }
      pendingStatusNotifications.delete(workspaceId);
    }, STATUS_DEBOUNCE_MS);
    pendingStatusNotifications.set(workspaceId, timeout);
  }
};
