import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { Server } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin
// In production (VPC), this will use the service account from env or metadata server
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

// Store active workers: Map<OwnerUID, SocketID>
const userWorkers = new Map<string, string>();

// Store active sessions: Map<SessionID, SessionData>
interface SessionData {
    ownerUid: string;
    workerSocketId: string;
    output: string; // Buffer last output
    workspaceId?: string;
    workspaceName?: string;
    workspaceType?: string;
}
const sessions = new Map<string, SessionData>();

const endSession = (sessionId: string, reason: string) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  io.to(sessionId).emit('session-ended', { sessionId, reason });
};

const endSessionsByOwner = (ownerUid: string, reason: string) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.ownerUid === ownerUid) {
      endSession(sessionId, reason);
    }
  }
};

const endSessionsByWorker = (workerSocketId: string, reason: string) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.workerSocketId === workerSocketId) {
      endSession(sessionId, reason);
    }
  }
};

// Middleware: Authentication
io.use(async (socket, next) => {
  const { type, token, workerToken, uid } = socket.handshake.auth;

  try {
    if (type === 'client') {
      // Clients MUST provide a Firebase ID Token
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
      // Workers provide a Service Token. 
      // For simplicity in V1, let's assume the Worker Token IS the User UID.
      // In a real app, you'd verify this against a database of generated API keys.
      if (!workerToken) return next(new Error('Missing worker token'));
      
      // Verification logic here (e.g. check DB if this API key belongs to a user)
      // socket.data.ownerUid = await lookupOwnerByApiKey(workerToken);
      
      // Temporary: Trust that workerToken is the UID
      socket.data.ownerUid = workerToken; 
      socket.data.role = 'worker';
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
  const uid = socket.data.uid || socket.data.ownerUid;

  console.log(`Using role: ${role} for user: ${uid} (Socket: ${socket.id})`);

  if (role === 'worker') {
    // Register Worker
    userWorkers.set(uid, socket.id);
    console.log(`✅ Worker registered for User ${uid}`);
    
    // Notify any connected clients of this user
    io.to(`user:${uid}`).emit('worker-status', { status: 'online' });

    socket.on('disconnect', () => {
      userWorkers.delete(uid);
      endSessionsByWorker(socket.id, 'worker-disconnected');
      io.to(`user:${uid}`).emit('worker-status', { status: 'offline' });
      console.log(`❌ Worker disconnected for User ${uid}`);
    });

    socket.on('output', (payload: { sessionId: string; output?: string; data?: string }) => {
        // Forward output to the specific session room
        // Normalize payload for client: Client expects { sessionId, data }
        const session = sessions.get(payload.sessionId);
        if (!session || session.workerSocketId !== socket.id) return;
        io.to(payload.sessionId).emit('output', {
            sessionId: payload.sessionId,
            data: payload.output || payload.data || ''
        });
    });
  }

  if (role === 'client') {
    // Client joins their own "User Room" to get status updates
    socket.join(`user:${uid}`);

    // Check if they have a worker online
    const workerSocketId = userWorkers.get(uid);
    socket.emit('worker-status', { status: workerSocketId ? 'online' : 'offline' });

    socket.on('create-session', (payload?: { workspaceId?: string; workspaceName?: string; workspaceType?: string }) => {
        const workerId = userWorkers.get(uid);
        if (!workerId) {
            return socket.emit('error', 'No worker available');
        }

        endSessionsByOwner(uid, 'replaced');

        const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId : undefined;
        const workspaceName = typeof payload?.workspaceName === 'string' ? payload.workspaceName : undefined;
        const workspaceType = typeof payload?.workspaceType === 'string' ? payload.workspaceType : undefined;

        const sessionId = `sess_${uid}_${Date.now()}`;
        sessions.set(sessionId, {
            ownerUid: uid,
            workerSocketId: workerId,
            output: '',
            workspaceId,
            workspaceName,
            workspaceType
        });

        socket.join(sessionId); // Client joins session room

        // Tell worker to spawn a PTY shell
        io.to(workerId).emit('session-created', {
            id: sessionId,
            workspaceId,
            workspaceName,
            workspaceType
        });

        socket.emit('session-created', { id: sessionId });
    });

    socket.on('execute', (data: { sessionId: string; command: string }) => {
        const session = sessions.get(data.sessionId);
        // Security: Ensure user owns this session
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

    socket.on('disconnect', () => {
        endSessionsByOwner(uid, 'client-disconnected');
    });
  }
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
});
