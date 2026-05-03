import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';
import * as crypto from 'crypto';

dotenv.config();

type ServiceAccountWithProjectId = admin.ServiceAccount & { project_id?: string };

if (!admin.apps.length) {
  try {
    let serviceAccount: admin.ServiceAccount | null = null;

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialsPath && existsSync(credentialsPath)) {
      try {
        const fileContent = readFileSync(credentialsPath, 'utf-8');
        serviceAccount = JSON.parse(fileContent) as admin.ServiceAccount;
        console.log('🔑 Loaded credentials from file:', credentialsPath);
      } catch (fileError) {
        console.warn('Failed to read GOOGLE_APPLICATION_CREDENTIALS file:', fileError);
      }
    }

    if (!serviceAccount) {
      const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (serviceAccountRaw) {
        try {
          serviceAccount = JSON.parse(serviceAccountRaw) as admin.ServiceAccount;
          console.log('🔑 Loaded credentials from FIREBASE_SERVICE_ACCOUNT env');
        } catch (_parseError) {
          // Backward-compat: allow base64-encoded JSON
          try {
            const decoded = Buffer.from(serviceAccountRaw, 'base64').toString('utf-8');
            serviceAccount = JSON.parse(decoded) as admin.ServiceAccount;
            console.log('🔑 Loaded credentials from FIREBASE_SERVICE_ACCOUNT (base64)');
          } catch (_decodeError) {
            console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials.');
          }
        }
      }
    }

    if (serviceAccount) {
      const serviceAccountWithProjectId = serviceAccount as ServiceAccountWithProjectId;
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccountWithProjectId.project_id
      });
    } else {
      admin.initializeApp();
    }
    console.log('🔥 Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase Admin init failed:', error);
  }
}

const app = express();

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);

    try {
      const originUrl = new URL(origin);
      if (CLIENT_ORIGINS.some(allowed => origin === allowed || allowed === originUrl.origin)) {
        return callback(null, true);
      }
    } catch (e) {
      // Invalid origin URL
    }

    console.warn(`⚠️ CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

let httpServer;
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;

if (sslKeyPath && sslCertPath && existsSync(sslKeyPath) && existsSync(sslCertPath)) {
  console.log('🔒 Initializing secure HTTPS server...');
  try {
    const httpsOptions = {
        key: readFileSync(sslKeyPath),
        cert: readFileSync(sslCertPath)
    };
    httpServer = createHttpsServer(httpsOptions, app);
    console.log('✅ HTTPS Server Created');
  } catch (e) {
    console.error('❌ Failed to create SSL server, falling back to HTTP', e);
    httpServer = createServer(app);
  }
} else {
  console.log('⚠️ No SSL keys found, initializing insecure HTTP server...');
  httpServer = createServer(app);
}

const io = new Server(httpServer, {
  cors: corsOptions
});

interface WorkerInfo {
  socketId: string;
  socket: Socket;
  workspaceType: 'personal' | 'shared';
  ownerId?: string;
}

interface SessionData {
  ownerUid: string;
  workerSocketId: string;
  workspaceId: string;
  workspaceName?: string;
  workspaceType: 'personal' | 'shared';
  sessionName?: string;
  outputChunks: string[];
  outputSize: number;
}

interface AgentCommandResultPayload {
  requestId: string;
  workspaceId: string;
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  durationMs: number;
}

const workersByWorkspace = new Map<string, WorkerInfo>();

const sessions = new Map<string, SessionData>();

// Reverse index: workerSocketId → Set<sessionId> for O(1) lookup on worker disconnect
const sessionsByWorker = new Map<string, Set<string>>();

const pendingAgentCommands = new Map<string, {
  workspaceId: string;
  workerSocketId: string;
  resolve: (payload: AgentCommandResultPayload) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

const pendingStatusNotifications = new Map<string, NodeJS.Timeout>();
const STATUS_DEBOUNCE_MS = 2000;
const WORKER_SECRET = (process.env.WORKER_SECRET || '').trim();
const ALLOW_LEGACY_WORKER_TOKENS = process.env.ALLOW_LEGACY_WORKER_TOKENS === 'true';
const WORKER_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_HISTORY_BUFFER = 500000; // 500KB buffer per session
const PERSONAL_WORKSPACE_PREFIX = 'personal:';

if (!WORKER_SECRET) {
  console.error('WORKER_SECRET is required.');
  process.exit(1);
}

const isPersonalWorkspaceToken = (workspaceId: string) => workspaceId.startsWith(PERSONAL_WORKSPACE_PREFIX);

const getPersonalWorkspaceOwnerId = (workspaceId: string) =>
  isPersonalWorkspaceToken(workspaceId) ? workspaceId.slice(PERSONAL_WORKSPACE_PREFIX.length) : null;

const getWorkspaceTypeFromId = (workspaceId: string): 'personal' | 'shared' =>
  isPersonalWorkspaceToken(workspaceId) ? 'personal' : 'shared';

const WORKSPACE_ACCESS_CACHE_TTL = 60_000;
const workspaceAccessCache = new Map<string, { result: boolean; expiresAt: number }>();

const canUserAccessWorkspace = async (workspaceId: string, uid: string): Promise<boolean> => {
  if (!workspaceId || !uid) return false;
  if (isPersonalWorkspaceToken(workspaceId)) {
    return getPersonalWorkspaceOwnerId(workspaceId) === uid;
  }

  const cacheKey = `${workspaceId}:${uid}`;
  const cached = workspaceAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const snap = await admin.firestore().collection('workspaces').doc(workspaceId).get();
  const result = snap.exists && Array.isArray((snap.data() as { members?: unknown } | undefined)?.members)
    && (snap.data() as { members: unknown[] }).members.includes(uid);
  workspaceAccessCache.set(cacheKey, { result, expiresAt: Date.now() + WORKSPACE_ACCESS_CACHE_TTL });
  return result;
};

const canUserAccessSession = async (session: SessionData, uid: string): Promise<boolean> => {
  if (session.ownerUid === uid) return true;
  return canUserAccessWorkspace(session.workspaceId, uid);
};

const isAdminUser = async (uid: string): Promise<boolean> => {
  if (!uid) return false;
  const snap = await admin.firestore().collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const data = snap.data() as { role?: unknown } | undefined;
  return typeof data?.role === 'string' && ['admin', 'superadmin'].includes(data.role.toLowerCase());
};

const authenticateHttpUser = async (req: express.Request, res: express.Response): Promise<admin.auth.DecodedIdToken | null> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_error) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
};

const getWorkspaceSessions = (workspaceId: string) => (
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

// Parse legacy token format (for backward compatibility during migration)
function parseLegacyWorkerToken(token: string): { workspaceId: string; workspaceType: 'personal' | 'shared'; ownerId?: string } | null {
  // Legacy format: "personal:userId" or "workspaceId"
  if (!token || token.includes('.')) return null; // Not a legacy token if it has a dot (signed format)

  if (token.startsWith('personal:')) {
    const ownerId = token.substring('personal:'.length);
    return { workspaceId: token, workspaceType: 'personal', ownerId };
  }
  return { workspaceId: token, workspaceType: 'shared' };
}

function verifyWorkerToken(token: string): { workspaceId: string; workspaceType: 'personal' | 'shared'; ownerId?: string } | null {
  try {
    const [payloadB64, signature] = token.split('.');
    if (payloadB64 && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', WORKER_SECRET)
        .update(payloadB64)
        .digest('hex');

      if (signature === expectedSignature) {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8')) as {
          workspaceId?: unknown;
          workspaceType?: unknown;
          ownerId?: unknown;
          timestamp?: unknown;
        };
        if (typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) return null;

        const workspaceId = payload.workspaceId.trim();
        const workspaceType = getWorkspaceTypeFromId(workspaceId);
        const ownerId = typeof payload.ownerId === 'string' && payload.ownerId.trim()
          ? payload.ownerId.trim()
          : undefined;
        const personalOwnerId = getPersonalWorkspaceOwnerId(workspaceId);
        if (workspaceType === 'personal' && ownerId !== personalOwnerId) return null;
        if (payload.workspaceType !== workspaceType) return null;
        if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return null;

        const ageMs = Date.now() - payload.timestamp;
        if (ageMs < -10_000 || ageMs > WORKER_TOKEN_MAX_AGE_MS) return null;

        return { workspaceId, workspaceType, ownerId };
      }
    }
  } catch (e) {
    return null;
  }

  if (!ALLOW_LEGACY_WORKER_TOKENS) {
    return null;
  }

  const legacyParsed = parseLegacyWorkerToken(token);
  if (legacyParsed) {
    console.warn(`⚠️ Legacy token format used for workspace: ${legacyParsed.workspaceId} - Please update worker`);
    return legacyParsed;
  }

  return null;
}

const notifyWorkspaceSessions = (workspaceId: string) => {
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

const endSession = (sessionId: string, reason: string) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const workspaceId = session.workspaceId;
  sessions.delete(sessionId);
  // Maintain reverse index
  const workerSessions = sessionsByWorker.get(session.workerSocketId);
  if (workerSessions) {
    workerSessions.delete(sessionId);
    if (workerSessions.size === 0) sessionsByWorker.delete(session.workerSocketId);
  }
  io.to(sessionId).emit('session-ended', { sessionId, reason });
  notifyWorkspaceSessions(workspaceId);
};

const endSessionsByWorker = (workerSocketId: string, reason: string) => {
  const workerSessions = sessionsByWorker.get(workerSocketId);
  if (!workerSessions) return;
  for (const sessionId of [...workerSessions]) {
    endSession(sessionId, reason);
  }
};

const notifyWorkspaceStatus = (workspaceId: string, status: 'online' | 'offline') => {
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

io.use(async (socket, next) => {
  const { type, token, workerToken } = socket.handshake.auth;

  try {
    if (type === 'client') {
      if (!token) return next(new Error('Missing client token'));

      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.data.uid = decodedToken.uid;
        console.log(`✅ Client authenticated: ${decodedToken.uid}`);

        if (socket.handshake.auth.sessionId) {
          socket.data.requestedSessionId = socket.handshake.auth.sessionId;
        }

      } catch (e) {
        console.error('Token verification failed:', e);
        return next(new Error('Authentication failed'));
      }

      socket.data.role = 'client';
      return next();
    }

    if (type === 'worker') {
      if (!workerToken) return next(new Error('Missing worker token'));

      const payload = verifyWorkerToken(workerToken);
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
      if (!workerToken) return next(new Error('Missing worker token for sync-agent'));

      // Reusing verifyWorkerToken instead of raw secret check
      const payload = verifyWorkerToken(workerToken);

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
  } catch (e) {
    console.error('Connection error:', e);
    return next(new Error('Internal Server Error'));
  }
});

io.on('connection', (socket) => {
  const role = socket.data.role;

  if (role === 'worker') {
    const workspaceId = socket.data.workspaceId;
    const workspaceType = socket.data.workspaceType;
    const ownerId = socket.data.ownerId;

    const existing = workersByWorkspace.get(workspaceId);
    if (existing) {
      if (existing.socket.connected) {
        console.log(`⚠️ Worker already connected for workspace ${workspaceId}, rejecting duplicate`);
        socket.emit('error', { message: 'Worker already connected for this workspace' });
        socket.disconnect(true);
        return;
      }
      console.log(`🔄 Cleaning up stale worker for workspace ${workspaceId}`);
      endSessionsByWorker(existing.socketId, 'worker-replaced');
    }

    workersByWorkspace.set(workspaceId, {
      socketId: socket.id,
      socket,
      workspaceType,
      ownerId
    });

    console.log(`✅ Worker registered for Workspace: ${workspaceId} [Type: ${workspaceType}]`);

    notifyWorkspaceStatus(workspaceId, 'online');

    socket.on('disconnect', () => {
      const current = workersByWorkspace.get(workspaceId);
      if (current?.socketId === socket.id) {
        workersByWorkspace.delete(workspaceId);
        endSessionsByWorker(socket.id, 'worker-disconnected');
        notifyWorkspaceStatus(workspaceId, 'offline');
        console.log(`❌ Worker disconnected for Workspace: ${workspaceId}`);
      }
    });

    socket.on('output', (payload: { sessionId: string; output?: string; data?: string }) => {
      const session = sessions.get(payload.sessionId);
      if (!session || session.workerSocketId !== socket.id) return;

      const data = payload.output || payload.data || '';

      // Buffer output for history replay (ring buffer to avoid GC pressure)
      session.outputChunks.push(data);
      session.outputSize += data.length;
      while (session.outputSize > MAX_HISTORY_BUFFER) {
        const removed = session.outputChunks.shift()!;
        session.outputSize -= removed.length;
      }

      io.to(payload.sessionId).emit('output', {
        sessionId: payload.sessionId,
        data
      });
    });

    socket.on('session-ended', (payload: { sessionId: string; reason: string }) => {
      const session = sessions.get(payload.sessionId);
      if (session && session.workerSocketId === socket.id) {
        endSession(payload.sessionId, payload.reason);
      }
    });

    socket.on('agent-command-result', (payload: AgentCommandResultPayload) => {
      const pending = pendingAgentCommands.get(payload.requestId);
      if (!pending || pending.workerSocketId !== socket.id || pending.workspaceId !== workspaceId) {
        return;
      }
      clearTimeout(pending.timeout);
      pendingAgentCommands.delete(payload.requestId);
      pending.resolve(payload);
    });
  }

  if (role === 'sync-agent') {
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
          // Personal workspace: authenticate as user but with sync-agent claims
          uidToMint = ownerId;
          additionalClaims = { workspaceId, role: 'sync-agent' };
        } else {
          // For shared workspace, use a service identity
          uidToMint = `sync-agent:${workspaceId}`;
          additionalClaims = { workspaceId, role: 'sync-agent' };
        }

        const token = await admin.auth().createCustomToken(uidToMint, additionalClaims);
        socket.emit('firebase-custom-token', { token });
        console.log(`🔑 Sent custom token to sync-agent for ${uidToMint}`);
      } catch (e) {
        console.error('Error minting token for sync-agent:', e);
      }
    };

    // Send initial token
    void mintAndSendToken();

    // Re-auth: sync-agent requests a new token when the previous one expires
    socket.on('request-firebase-token', () => {
      console.log(`🔑 Sync-Agent requesting token refresh for ${workspaceId}`);
      void mintAndSendToken();
    });

    socket.on('doc-change', (payload: {
      workspaceId: string;
      docId: string;
      action: 'created' | 'updated' | 'deleted';
      data?: { name?: string; parentId?: string | null };
    }) => {
      const roomName = `workspace:${payload.workspaceId}`;
      console.log(`[Hub] doc-change: ${payload.action} ${payload.docId} in ${payload.workspaceId}`);

      io.to(roomName).emit('doc-change', payload);
    });

    socket.on('disconnect', () => {
      console.log(`📁 Sync-Agent disconnected for Workspace: ${workspaceId}`);
    });
  }

  if (role === 'client') {
    const uid = socket.data.uid;
    console.log(`👤 Client connected: ${uid} (Socket: ${socket.id})`);

    if (socket.data.requestedSessionId) {
      void (async () => {
        const session = sessions.get(socket.data.requestedSessionId);
        if (!session) return;

        const allowed = await canUserAccessSession(session, uid);
        if (!allowed) return;

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

    socket.on('workspace:subscribe', async (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      if (!workspaceId || !(await canUserAccessWorkspace(workspaceId, uid))) {
        socket.emit('error', { message: 'No autorizado para este espacio', workspaceId });
        return;
      }

      const roomName = `workspace:${workspaceId}`;

      await socket.join(roomName);
      console.log(`[Hub] Client ${uid} subscribed to ${roomName}`);

      const worker = workersByWorkspace.get(workspaceId);
      socket.emit('worker-status', {
        status: worker ? 'online' : 'offline',
        workspaceId
      });

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
      socket.emit('workspace-sessions', {
        workspaceId,
        sessions: activeSessions
      });
    });

    socket.on('workspace:unsubscribe', async (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const roomName = `workspace:${workspaceId}`;
      await socket.leave(roomName);
      console.log(`[Hub] Client ${uid} unsubscribed from ${roomName}`);
    });

    socket.on('workspace:check-worker', async (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      if (!workspaceId || !(await canUserAccessWorkspace(workspaceId, uid))) {
        socket.emit('error', { message: 'No autorizado para este espacio', workspaceId });
        return;
      }

      const worker = workersByWorkspace.get(workspaceId);
      socket.emit('worker-status', {
        status: worker ? 'online' : 'offline',
        workspaceId
      });
    });

    socket.on('restore-session', async (payload: { sessionId?: string }) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) return;

      const session = sessions.get(sessionId);
      if (!session) {
        // Session no longer exists on hub (e.g. hub restarted)
        // Emit restore-failed so the client can handle gracefully without deleting from localStorage immediately
        socket.emit('restore-failed', { sessionId, reason: 'session-not-found' });
        return;
      }

      const allowed = await canUserAccessSession(session, uid);
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

      // HISTORY REPLAY for restored session
      if (session.outputChunks.length > 0) {
        socket.emit('output', {
          sessionId,
          data: session.outputChunks.join('')
        });
      }
    });

    // Allow users to join an existing session in a shared workspace for live viewing
    socket.on('join-session', async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      if (!sessionId) return;

      const session = sessions.get(sessionId);
      if (!session) {
        socket.emit('join-session-failed', { sessionId, reason: 'session-not-found' });
        return;
      }

      const isOwner = session.ownerUid === uid;
      const allowed = await canUserAccessSession(session, uid);
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

      // Replay session history for the joining user
      if (session.outputChunks.length > 0) {
        socket.emit('output', {
          sessionId,
          data: session.outputChunks.join('')
        });
      }
    });

    socket.on('create-session', async (payload: { workspaceId: string; workspaceName?: string; workspaceType?: 'personal' | 'shared'; sessionName?: string }) => {
      const { workspaceId, workspaceName, sessionName } = payload;

      console.log(`[Hub] create-session request from ${uid} for workspace ${workspaceId}`);

      if (!workspaceId || !(await canUserAccessWorkspace(workspaceId, uid))) {
        return socket.emit('error', {
          message: 'No autorizado para este espacio de trabajo',
          workspaceId
        });
      }

      const worker = workersByWorkspace.get(workspaceId);

      if (!worker) {
        console.log(`[Hub] No worker found for workspace ${workspaceId}`);
        return socket.emit('error', {
          message: `No hay worker conectado para este espacio de trabajo`,
          workspaceId
        });
      }

      const sessionId = `sess_${workspaceId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;

      sessions.set(sessionId, {
        ownerUid: uid,
        workerSocketId: worker.socketId,
        workspaceId,
        workspaceName,
        workspaceType: getWorkspaceTypeFromId(workspaceId),
        sessionName: sessionName || undefined,
        outputChunks: [],
        outputSize: 0
      });
      // Maintain reverse index
      const workerSessions = sessionsByWorker.get(worker.socketId) ?? new Set<string>();
      workerSessions.add(sessionId);
      sessionsByWorker.set(worker.socketId, workerSessions);

      await socket.join(sessionId);

      io.to(worker.socketId).emit('session-created', {
        id: sessionId,
        workspaceId,
        workspaceName,
        workspaceType: getWorkspaceTypeFromId(workspaceId)
      });

      socket.emit('session-created', {
        id: sessionId,
        workspaceId,
        sessionName: sessionName || undefined
      });

      notifyWorkspaceSessions(workspaceId);

      console.log(`[Hub] Session created: ${sessionId} for workspace ${workspaceId}`);
    });

    socket.on('rename-session', async (payload: { sessionId: string; sessionName: string }) => {
      const { sessionId, sessionName } = payload;
      const session = sessions.get(sessionId);
      if (!session) return;

      const isOwner = session.ownerUid === uid;
      const canCollaborate = session.workspaceType === 'shared'
        && socket.rooms.has(sessionId)
        && await canUserAccessSession(session, uid);
      if (!isOwner && !canCollaborate) return;

      session.sessionName = sessionName;
      console.log(`[Hub] Session renamed: ${sessionId} -> "${sessionName}" by ${uid}`);

      // Broadcast to all clients in this workspace
      io.to(`workspace:${session.workspaceId}`).emit('session-renamed', {
        sessionId,
        sessionName
      });
    });

    socket.on('execute', async (data: { sessionId: string; command: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session) return;

      const isOwner = session.ownerUid === uid;
      const canCollaborate = session.workspaceType === 'shared'
        && socket.rooms.has(data.sessionId)
        && await canUserAccessSession(session, uid);
      if (!isOwner && !canCollaborate) return;

      io.to(session.workerSocketId).emit('execute', {
        sessionId: data.sessionId,
        command: data.command
      });
    });

    socket.on('resize', (data: { sessionId: string; cols: number; rows: number }) => {
      const session = sessions.get(data.sessionId);
      if (!session) return;
      // tmux-like: solo el owner puede redimensionar el PTY
      // Los viewers tienen su propio grid local via xterm.js
      if (session.ownerUid !== uid) return;

      io.to(session.workerSocketId).emit('resize', {
        sessionId: data.sessionId,
        cols: data.cols,
        rows: data.rows
      });
    });

    socket.on('kill-session', (data: { sessionId: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;

      io.to(session.workerSocketId).emit('kill-session', { sessionId: data.sessionId });
      endSession(data.sessionId, 'user-terminated');
    });

    socket.on('disconnect', () => {
      console.log(`👤 Client disconnected: ${uid}`);
    });
  }
});

app.get('/health', (req, res) => {
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
        ownerId: worker.ownerId || null
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

/**
 * Rate limit deslizante por workspace para `/agent/run-command`. Evita que un
 * agente saturado dispare 50 comandos seguidos en un worker.
 */
const AGENT_CMD_WINDOW_MS = 30_000;
const AGENT_CMD_MAX_PER_WINDOW = 8;
const agentCommandHistory = new Map<string, number[]>();

function checkAgentCommandRateLimit(workspaceId: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const arr = agentCommandHistory.get(workspaceId) ?? [];
  const recent = arr.filter((t) => now - t < AGENT_CMD_WINDOW_MS);
  if (recent.length >= AGENT_CMD_MAX_PER_WINDOW) {
    const earliest = recent[0]!;
    return { ok: false, retryAfterMs: AGENT_CMD_WINDOW_MS - (now - earliest) };
  }
  recent.push(now);
  agentCommandHistory.set(workspaceId, recent);
  return { ok: true, retryAfterMs: 0 };
}

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

  const requestId = `agent_${workspaceId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

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

// Protected status endpoint (basic auth or admin token)
app.get('/status', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
     return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
     const decoded = await admin.auth().verifyIdToken(token);
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
    connected: info.socket.connected
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

const resolvePort = () => {
  if (process.env.PORT) {
    return parseInt(process.env.PORT, 10);
  }
  const fallbackUrl = process.env.NEXUS_URL || process.env.NEXT_PUBLIC_NEXUS_URL;
  if (fallbackUrl) {
    try {
      const parsed = new URL(fallbackUrl);
      if (parsed.port) {
        return parseInt(parsed.port, 10);
      }
      return parsed.protocol === 'https:' ? 443 : 80;
    } catch (error) {
      console.warn('Invalid NEXUS_URL, using default port');
    }
  }
  return 3002;
};

const PORT = resolvePort();
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Hub Service running on port ${PORT}`);
  console.log(`📡 Architecture: Workers registered per Workspace`);
});
