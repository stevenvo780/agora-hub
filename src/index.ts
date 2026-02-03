import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

if (!admin.apps.length) {
  try {
    let serviceAccount: admin.ServiceAccount | null = null;

    // Option 1: GOOGLE_APPLICATION_CREDENTIALS (file path)
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

    // Option 2: FIREBASE_SERVICE_ACCOUNT (inline JSON)
    if (!serviceAccount) {
      const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (serviceAccountRaw) {
        try {
          serviceAccount = JSON.parse(serviceAccountRaw) as admin.ServiceAccount;
          console.log('🔑 Loaded credentials from FIREBASE_SERVICE_ACCOUNT env');
        } catch (parseError) {
          console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials.');
        }
      }
    }

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || (serviceAccount as any).project_id,
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
    if (CLIENT_ORIGINS.some(allowed => origin === allowed || origin.startsWith(allowed.replace(/\/$/, '')))) {
      return callback(null, true);
    }
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
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

// Debounce para notificaciones de status del worker (evita spam offline/online)
const pendingStatusNotifications = new Map<string, NodeJS.Timeout>();
const STATUS_DEBOUNCE_MS = 2000; // 2 segundos de gracia antes de notificar offline

function parseWorkerToken(token: string): { workspaceId: string; workspaceType: 'personal' | 'shared'; ownerId?: string } {
  if (token.startsWith('personal:')) {
    const ownerId = token.substring('personal:'.length);
    return { workspaceId: token, workspaceType: 'personal', ownerId };
  }
  return { workspaceId: token, workspaceType: 'shared' };
}

const endSession = (sessionId: string, reason: string) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  io.to(sessionId).emit('session-ended', { sessionId, reason });
};

const endSessionsByWorker = (workerSocketId: string, reason: string) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.workerSocketId === workerSocketId) {
      endSession(sessionId, reason);
    }
  }
};

const notifyWorkspaceStatus = (workspaceId: string, status: 'online' | 'offline') => {
  // Cancelar cualquier notificación pendiente
  const pending = pendingStatusNotifications.get(workspaceId);
  if (pending) {
    clearTimeout(pending);
    pendingStatusNotifications.delete(workspaceId);
  }

  if (status === 'online') {
    // Online se notifica inmediatamente
    console.log(`[Hub] Broadcasting worker-status: ${status} for workspace: ${workspaceId}`);
    io.to(`workspace:${workspaceId}`).emit('worker-status', { status, workspaceId });
  } else {
    // Offline usa debounce - solo notifica si después de 2s sigue sin worker
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
  const { type, token, workerToken, uid } = socket.handshake.auth;

  try {
    if (type === 'client') {
      if (!token) return next(new Error('Missing client token'));
      
      // Verify Firebase token
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.data.uid = decodedToken.uid;
        console.log(`✅ Client authenticated: ${decodedToken.uid}`);
        
        // Check for session ID attempt
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
      
      const parsed = parseWorkerToken(workerToken);
      socket.data.workspaceId = parsed.workspaceId;
      socket.data.workspaceType = parsed.workspaceType;
      socket.data.ownerId = parsed.ownerId;
      socket.data.role = 'worker';
      
      return next();
    }

    // sync-agent: proceso de sincronización de archivos
    if (type === 'sync-agent') {
      if (!workerToken) return next(new Error('Missing worker token for sync-agent'));
      
      const parsed = parseWorkerToken(workerToken);
      socket.data.workspaceId = parsed.workspaceId;
      socket.data.workspaceType = parsed.workspaceType;
      socket.data.ownerId = parsed.ownerId;
      socket.data.role = 'sync-agent';
      
      return next();
    }

    return next(new Error('Invalid connection type'));
  } catch (err) {
    console.error('Auth Error:', err);
    return next(new Error('Authentication failed'));
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
      // Si el socket existente aún está conectado, rechazar la nueva conexión
      if (existing.socket.connected) {
        console.log(`⚠️ Worker already connected for workspace ${workspaceId}, rejecting duplicate`);
        socket.emit('error', { message: 'Worker already connected for this workspace' });
        socket.disconnect(true);
        return;
      }
      // Si el socket existente ya no está conectado, limpiar
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
      io.to(payload.sessionId).emit('output', {
        sessionId: payload.sessionId,
        data: payload.output || payload.data || ''
      });
    });

    socket.on('session-ended', (payload: { sessionId: string; reason: string }) => {
      const session = sessions.get(payload.sessionId);
      if (session && session.workerSocketId === socket.id) {
        endSession(payload.sessionId, payload.reason);
      }
    });
  }

  // Handler para sync-agent: reenvía eventos de cambios de documentos a los clientes
  if (role === 'sync-agent') {
    const workspaceId = socket.data.workspaceId;
    console.log(`📁 Sync-Agent connected for Workspace: ${workspaceId} (Socket: ${socket.id})`);

    socket.on('doc-change', (payload: { 
      workspaceId: string; 
      docId: string; 
      action: 'created' | 'updated' | 'deleted';
      data?: { name?: string; parentId?: string | null };
    }) => {
      const roomName = `workspace:${payload.workspaceId}`;
      console.log(`[Hub] doc-change: ${payload.action} ${payload.docId} in ${payload.workspaceId}`);
      
      // Reenviar a todos los clientes suscritos al workspace
      io.to(roomName).emit('doc-change', payload);
    });

    socket.on('disconnect', () => {
      console.log(`📁 Sync-Agent disconnected for Workspace: ${workspaceId}`);
    });
  }

  if (role === 'client') {
    const uid = socket.data.uid;
    console.log(`👤 Client connected: ${uid} (Socket: ${socket.id})`);

    // Attempt Session Restoration
    if (socket.data.requestedSessionId) {
       const session = sessions.get(socket.data.requestedSessionId);
       if (session && session.ownerUid === uid) {
          console.log(`🔄 Restoring session ${socket.data.requestedSessionId} for user ${uid}`);
          socket.join(socket.data.requestedSessionId);
          
          socket.emit('session-created', { // Send as session-created to reuse frontend logic or specific restored event
             id: socket.data.requestedSessionId,
             workspaceId: session.workspaceId,
             workspaceName: session.workspaceName,
             workspaceType: session.workspaceType
          });

          // Also replay output if we had a buffer (we don't store full buffer currently, only 'output' string in interface but not populated?)
          // The interface SessionData has 'output: string'. Let's see if it's used.
          // In 'output' event handler: io.to... emit. It doesn't save to session.output. 
          // Ideally we should buffer last N lines. But strict requirement is just keeping the connection alive.
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
      // Don't kill sessions on disconnect to allow persistence
      // Only log the event
      console.log(`👤 Client disconnected: ${uid}`);
      
      // Optional: Set a timeout to clean up abandoned sessions after a long time (e.g. 1 hour)
      // But for now, we keep them as per user request "sesiones deben ser persistentes"
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
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
