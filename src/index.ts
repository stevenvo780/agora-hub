import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    let serviceAccount: admin.ServiceAccount | null = null;
    if (serviceAccountRaw) {
      try {
        serviceAccount = JSON.parse(serviceAccountRaw) as admin.ServiceAccount;
      } catch (parseError) {
        console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials.');
      }
    }
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID,
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

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: CLIENT_ORIGIN }));

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
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST']
  }
});

// =====================================================
// NEW ARCHITECTURE: Workers by Workspace (not by User)
// =====================================================
// Token formats:
// - "personal:{userId}" -> Personal workspace for that user
// - "{workspaceId}" -> Shared workspace (UUID)
// =====================================================

interface WorkerInfo {
  socketId: string;
  socket: Socket;
  workspaceType: 'personal' | 'shared';
  ownerId?: string; // For personal workspaces, the user who owns it
}

interface SessionData {
  ownerUid: string;         // User who created the session
  workerSocketId: string;   // Worker handling this session
  workspaceId: string;      // Workspace this session belongs to
  workspaceName?: string;
  workspaceType: 'personal' | 'shared';
  output: string;
}

// Map<workspaceId, WorkerInfo>
// workspaceId = "personal:{userId}" or "{sharedWorkspaceId}"
const workersByWorkspace = new Map<string, WorkerInfo>();

// Map<sessionId, SessionData>
const sessions = new Map<string, SessionData>();

// Parse token to get workspace info
function parseWorkerToken(token: string): { workspaceId: string; workspaceType: 'personal' | 'shared'; ownerId?: string } {
  if (token.startsWith('personal:')) {
    const ownerId = token.substring('personal:'.length);
    return { workspaceId: token, workspaceType: 'personal', ownerId };
  }
  // It's a shared workspace UUID
  return { workspaceId: token, workspaceType: 'shared' };
}

// Get workspaceId for a user's personal space
function getPersonalWorkspaceId(userId: string): string {
  return `personal:${userId}`;
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

const endSessionsByWorkspace = (workspaceId: string, reason: string) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.workspaceId === workspaceId) {
      endSession(sessionId, reason);
    }
  }
};

// Notify all clients in a workspace room about worker status
const notifyWorkspaceStatus = (workspaceId: string, status: 'online' | 'offline') => {
  console.log(`[Hub] Broadcasting worker-status: ${status} for workspace: ${workspaceId}`);
  io.to(`workspace:${workspaceId}`).emit('worker-status', { 
    status, 
    workspaceId 
  });
};

// =====================================================
// MIDDLEWARE: Authentication
// =====================================================
io.use(async (socket, next) => {
  const { type, token, workerToken, uid } = socket.handshake.auth;

  try {
    if (type === 'client') {
      if (!token) return next(new Error('Missing client token'));
      
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.data.uid = decodedToken.uid;
      } catch (e) {
        // Fallback for Dev/Custom Auth
        if (token === 'mock-token' && uid) {
          console.warn(`⚠️ Allowing insecure connection for User ${uid} (Mock Token)`);
          socket.data.uid = uid;
        } else {
          throw e;
        }
      }
      
      socket.data.role = 'client';
      return next();
    } 
    
    if (type === 'worker') {
      // Worker token is the workspaceId (or "personal:{userId}")
      if (!workerToken) return next(new Error('Missing worker token'));
      
      const parsed = parseWorkerToken(workerToken);
      socket.data.workspaceId = parsed.workspaceId;
      socket.data.workspaceType = parsed.workspaceType;
      socket.data.ownerId = parsed.ownerId;
      socket.data.role = 'worker';
      
      return next();
    }

    return next(new Error('Invalid connection type'));
  } catch (err) {
    console.error('Auth Error:', err);
    return next(new Error('Authentication failed'));
  }
});

// =====================================================
// CONNECTION HANDLING
// =====================================================
io.on('connection', (socket) => {
  const role = socket.data.role;

  // =====================================================
  // WORKER CONNECTION
  // =====================================================
  if (role === 'worker') {
    const workspaceId = socket.data.workspaceId;
    const workspaceType = socket.data.workspaceType;
    const ownerId = socket.data.ownerId;

    // Check if there's already a worker for this workspace
    const existing = workersByWorkspace.get(workspaceId);
    if (existing) {
      console.log(`⚠️ Worker already exists for workspace ${workspaceId}, replacing...`);
      existing.socket.disconnect(true);
      endSessionsByWorker(existing.socketId, 'worker-replaced');
    }

    // Register this worker
    workersByWorkspace.set(workspaceId, {
      socketId: socket.id,
      socket,
      workspaceType,
      ownerId
    });

    console.log(`✅ Worker registered for Workspace: ${workspaceId} [Type: ${workspaceType}]`);
    
    // Notify clients subscribed to this workspace
    notifyWorkspaceStatus(workspaceId, 'online');

    // Handle worker disconnect
    socket.on('disconnect', () => {
      const current = workersByWorkspace.get(workspaceId);
      if (current?.socketId === socket.id) {
        workersByWorkspace.delete(workspaceId);
        endSessionsByWorker(socket.id, 'worker-disconnected');
        notifyWorkspaceStatus(workspaceId, 'offline');
        console.log(`❌ Worker disconnected for Workspace: ${workspaceId}`);
      }
    });

    // Forward output from worker to session
    socket.on('output', (payload: { sessionId: string; output?: string; data?: string }) => {
      const session = sessions.get(payload.sessionId);
      if (!session || session.workerSocketId !== socket.id) return;
      io.to(payload.sessionId).emit('output', {
        sessionId: payload.sessionId,
        data: payload.output || payload.data || ''
      });
    });

    // Session ended by worker
    socket.on('session-ended', (payload: { sessionId: string; reason: string }) => {
      const session = sessions.get(payload.sessionId);
      if (session && session.workerSocketId === socket.id) {
        endSession(payload.sessionId, payload.reason);
      }
    });
  }

  // =====================================================
  // CLIENT CONNECTION
  // =====================================================
  if (role === 'client') {
    const uid = socket.data.uid;
    console.log(`👤 Client connected: ${uid} (Socket: ${socket.id})`);

    // Client subscribes to workspace updates
    socket.on('workspace:subscribe', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const roomName = `workspace:${workspaceId}`;
      
      socket.join(roomName);
      console.log(`[Hub] Client ${uid} subscribed to ${roomName}`);

      // Send current worker status for this workspace
      const worker = workersByWorkspace.get(workspaceId);
      socket.emit('worker-status', {
        status: worker ? 'online' : 'offline',
        workspaceId
      });
    });

    // Client unsubscribes from workspace
    socket.on('workspace:unsubscribe', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const roomName = `workspace:${workspaceId}`;
      socket.leave(roomName);
      console.log(`[Hub] Client ${uid} unsubscribed from ${roomName}`);
    });

    // Check worker status for a specific workspace
    socket.on('workspace:check-worker', (data: { workspaceId: string }) => {
      const { workspaceId } = data;
      const worker = workersByWorkspace.get(workspaceId);
      socket.emit('worker-status', {
        status: worker ? 'online' : 'offline',
        workspaceId
      });
    });

    // Create terminal session for a workspace
    socket.on('create-session', (payload: { workspaceId: string; workspaceName?: string; workspaceType?: 'personal' | 'shared' }) => {
      const { workspaceId, workspaceName, workspaceType = 'shared' } = payload;
      
      console.log(`[Hub] create-session request from ${uid} for workspace ${workspaceId}`);

      // Find worker for this workspace
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

      // Tell worker to spawn PTY
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

    // Execute command in session
    socket.on('execute', (data: { sessionId: string; command: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;

      io.to(session.workerSocketId).emit('execute', {
        sessionId: data.sessionId,
        command: data.command
      });
    });

    // Resize terminal
    socket.on('resize', (data: { sessionId: string; cols: number; rows: number }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;

      io.to(session.workerSocketId).emit('resize', {
        sessionId: data.sessionId,
        cols: data.cols,
        rows: data.rows
      });
    });

    // Kill session
    socket.on('kill-session', (data: { sessionId: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session || session.ownerUid !== uid) return;
      
      io.to(session.workerSocketId).emit('kill-session', { sessionId: data.sessionId });
      endSession(data.sessionId, 'user-terminated');
    });

    // Client disconnect
    socket.on('disconnect', () => {
      // End sessions owned by this user
      for (const [sessionId, session] of sessions.entries()) {
        if (session.ownerUid === uid) {
          endSession(sessionId, 'client-disconnected');
        }
      }
      console.log(`👤 Client disconnected: ${uid}`);
    });
  }
});

// =====================================================
// SERVER START
// =====================================================
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
