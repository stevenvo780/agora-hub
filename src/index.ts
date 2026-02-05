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
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccountWithProjectId.project_id,
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

let httpServer;
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;

if (sslKeyPath && sslCertPath && existsSync(sslKeyPath) && existsSync(sslCertPath)) {
  console.log('🔒 Initializing secure HTTPS server...');
  try {
    const httpsOptions = {
        key: readFileSync(sslKeyPath),
        cert: readFileSync(sslCertPath),
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
  output: string;
}

const workersByWorkspace = new Map<string, WorkerInfo>();

const sessions = new Map<string, SessionData>();

const pendingStatusNotifications = new Map<string, NodeJS.Timeout>();
const STATUS_DEBOUNCE_MS = 2000;
const WORKER_SECRET = process.env.WORKER_SECRET || 'default-insecure-secret-do-not-use';
const MAX_HISTORY_BUFFER = 500000; // 500KB buffer per session

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
  // First try signed token format
  try {
    const [payloadB64, signature] = token.split('.');
    if (payloadB64 && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', WORKER_SECRET)
        .update(payloadB64)
        .digest('hex');

      if (signature === expectedSignature) {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
        return payload; // { workspaceId, workspaceType, ownerId, timestamp? }
      }
    }
  } catch (e) {
    // Continue to legacy fallback
  }
  
  // Fallback to legacy format (TEMPORARY - remove after all workers are updated)
  const legacyParsed = parseLegacyWorkerToken(token);
  if (legacyParsed) {
    console.warn(`⚠️ Legacy token format used for workspace: ${legacyParsed.workspaceId} - Please update worker`);
    return legacyParsed;
  }
  
  return null;
}

const notifyWorkspaceSessions = (workspaceId: string) => {
  const activeSessions = Array.from(sessions.values())
    .filter(s => s.workspaceId === workspaceId)
    .map(s => ({
      id: getKeyByValue(sessions, s)!,
      workspaceId: s.workspaceId,
      workspaceName: s.workspaceName,
      workspaceType: s.workspaceType,
      ownerUid: s.ownerUid
    }));
  
  io.to(`workspace:${workspaceId}`).emit('workspace-sessions', {
    workspaceId,
    sessions: activeSessions
  });
};

function getKeyByValue<K, V>(map: Map<K, V>, value: V): K | undefined {
  for (const [key, val] of map.entries()) {
    if (val === value) return key;
  }
  return undefined;
}

const endSession = (sessionId: string, reason: string) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const workspaceId = session.workspaceId;
  sessions.delete(sessionId);
  io.to(sessionId).emit('session-ended', { sessionId, reason });
  notifyWorkspaceSessions(workspaceId);
};

const endSessionsByWorker = (workerSocketId: string, reason: string) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.workerSocketId === workerSocketId) {
      endSession(sessionId, reason);
    }
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
      
      // Buffer output for history replay
      session.output = (session.output || '') + data;
      if (session.output.length > MAX_HISTORY_BUFFER) {
        session.output = session.output.slice(-MAX_HISTORY_BUFFER);
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
  }

  if (role === 'sync-agent') {
    const workspaceId = socket.data.workspaceId;
    const workspaceType = socket.data.workspaceType;
    const ownerId = socket.data.ownerId;
    console.log(`📁 Sync-Agent connected for Workspace: ${workspaceId} (Socket: ${socket.id})`);

    // Generate and send custom token
    (async () => {
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
    })();

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
       const session = sessions.get(socket.data.requestedSessionId);
       if (session && session.ownerUid === uid) {
          console.log(`🔄 Restoring session ${socket.data.requestedSessionId} for user ${uid}`);
          socket.join(socket.data.requestedSessionId);
          
          socket.emit('session-created', {
             id: socket.data.requestedSessionId,
             workspaceId: session.workspaceId,
             workspaceName: session.workspaceName,
             workspaceType: session.workspaceType
          });
       }
    }

    socket.on('workspace:subscribe', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const roomName = `workspace:${workspaceId}`;
      
      socket.join(roomName);
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
          ownerUid: s.ownerUid
        }));
      socket.emit('workspace-sessions', {
        workspaceId,
        sessions: activeSessions
      });
    });

    socket.on('workspace:unsubscribe', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const roomName = `workspace:${workspaceId}`;
      socket.leave(roomName);
      console.log(`[Hub] Client ${uid} unsubscribed from ${roomName}`);
    });

    socket.on('workspace:check-worker', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const worker = workersByWorkspace.get(workspaceId);
      socket.emit('worker-status', {
        status: worker ? 'online' : 'offline',
        workspaceId
      });
    });

    socket.on('restore-session', (payload: { sessionId?: string }) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) return;

      const session = sessions.get(sessionId);
      if (!session || session.ownerUid !== uid) {
        socket.emit('session-ended', { sessionId, reason: 'restore-failed' });
        return;
      }

      socket.join(sessionId);
      socket.emit('session-created', {
        id: sessionId,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        workspaceType: session.workspaceType
      });

      // HISTORY REPLAY for restored session
      if (session.output && session.output.length > 0) {
        // Send previous history
        socket.emit('output', {
          sessionId: sessionId,
          data: session.output
        });
      }
    });

    socket.on('create-session', (payload: { workspaceId: string; workspaceName?: string; workspaceType?: 'personal' | 'shared' }) => {
      const { workspaceId, workspaceName, workspaceType = 'shared' } = payload;
      
      console.log(`[Hub] create-session request from ${uid} for workspace ${workspaceId}`);

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
        workspaceType,
        output: ''
      });

      socket.join(sessionId);

      io.to(worker.socketId).emit('session-created', {
        id: sessionId,
        workspaceId,
        workspaceName,
        workspaceType
      });

      socket.emit('session-created', { 
        id: sessionId,
        workspaceId 
      });
      
      notifyWorkspaceSessions(workspaceId);

      console.log(`[Hub] Session created: ${sessionId} for workspace ${workspaceId}`);
    });

    socket.on('execute', (data: { sessionId: string; command: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;

      io.to(session.workerSocketId).emit('execute', {
        sessionId: data.sessionId,
        command: data.command
      });
    });

    socket.on('resize', (data: { sessionId: string; cols: number; rows: number }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;

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

// Protected status endpoint (basic auth or admin token)
app.get('/status', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
     return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
     // Verify idToken or a special admin token
     // Here we re-use firebase admin to verify it's a valid user
     const decoded = await admin.auth().verifyIdToken(token);
     // Optional: check if user is admin
     // if (!decoded.admin) return res.status(403).json({ error: 'Forbidden' });
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
