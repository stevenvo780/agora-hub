import express from 'express';
import { Server } from 'socket.io';
import {
  getPersonalWorkspaceOwnerId,
  getWorkspaceTypeFromId
} from './lib/workerToken';
import { createSlidingWindowRateLimiter } from './lib/rateLimit';
import {
  workersByWorkspace,
  sessions,
  pendingAgentCommands,
  type AgentCommandResultPayload
} from './state';
import {
  authenticateHttpUser,
  canUserAccessWorkspace,
  isAdminUser
} from './auth';
import { getWorkspaceSessions } from './sessions';
import { makeAgentCommandRequestId } from './agentCommands';

// ── Rate limiting ────────────────────────────────────────────────

const AGENT_CMD_WINDOW_MS = 30_000;
const AGENT_CMD_MAX_PER_WINDOW = 8;
const agentCommandRateLimiter = createSlidingWindowRateLimiter({
  windowMs: AGENT_CMD_WINDOW_MS,
  maxPerWindow: AGENT_CMD_MAX_PER_WINDOW
});

function checkAgentCommandRateLimit(workspaceId: string): { ok: boolean; retryAfterMs: number } {
  return agentCommandRateLimiter.check(workspaceId);
}

// ── Route registration ───────────────────────────────────────────

export function registerRoutes(app: express.Application, io: Server) {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/agent/workspace-status', async (req, res) => {
    const decoded = await authenticateHttpUser(req, res);
    if (!decoded) return;

    const workspaceId = String(req.query.workspaceId || '');
    if (!workspaceId || !(await canUserAccessWorkspace(workspaceId, decoded.uid))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const worker = workersByWorkspace.get(workspaceId);
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
          workspaceType: getWorkspaceTypeFromId(workspaceId),
          ownerId: getPersonalWorkspaceOwnerId(workspaceId)
        },
      sessions: getWorkspaceSessions(workspaceId)
    });
  });

  app.post('/agent/run-command', async (req, res) => {
    const decoded = await authenticateHttpUser(req, res);
    if (!decoded) return;

    const workspaceId = String(req.body?.workspaceId || '');
    const command = String(req.body?.command || '');
    const cwd = String(req.body?.cwd || '.');
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs || 15000), 1000), 25000);
    const maxOutputBytes = Math.min(Math.max(Number(req.body?.maxOutputBytes || 12000), 1000), 20000);

    if (!workspaceId || !(await canUserAccessWorkspace(workspaceId, decoded.uid))) {
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

    const worker = workersByWorkspace.get(workspaceId);
    if (!worker || !worker.socket.connected) {
      return res.status(409).json({ error: 'No hay worker conectado para este workspace' });
    }

    const requestId = makeAgentCommandRequestId(workspaceId);

    try {
      const result = await new Promise<AgentCommandResultPayload>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingAgentCommands.delete(requestId);
          reject(new Error('Timeout esperando resultado del worker'));
        }, timeoutMs + 5000);

        pendingAgentCommands.set(requestId, {
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
    } catch (error) {
      const pending = pendingAgentCommands.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingAgentCommands.delete(requestId);
      }
      res.status(504).json({ error: error instanceof Error ? error.message : 'Worker command failed' });
    }
  });

  // Protected status endpoint (admin only)
  app.get('/status', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
       return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    try {
       const decoded = await (await import('firebase-admin')).auth().verifyIdToken(token!);
       if (!(await isAdminUser(decoded.uid))) {
         return res.status(403).json({ error: 'Forbidden' });
       }
       console.log(`🔎 Status checked by ${decoded.uid}`);
    } catch (e) {
       console.warn('Status endpoint auth failed');
       return res.status(403).json({ error: 'Forbidden' });
    }

    const workers = Array.from(workersByWorkspace.entries()).map(([id, info]) => ({
      workspaceId: id,
      socketId: info.socketId,
      workspaceType: info.workspaceType,
      ownerId: info.ownerId,
      connected: info.socket.connected,
      connectedAt: info.connectedAt,
      lastHeartbeatAt: info.lastHeartbeatAt,
      metrics: info.metrics ?? null
    }));

    const activeSessions = Array.from(sessions.entries()).map(([id, session]) => ({
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
