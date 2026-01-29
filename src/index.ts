import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin
// In production (VPC), this will use the service account from env or metadata server
if (!admin.apps.length) {
  try {
    admin.initializeApp();
    console.log('🔥 Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase Admin init failed:', error);
  }
}

const app = express();
const httpServer = createServer(app);

// Allow connections from your Next.js frontend
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';

app.use(cors({ origin: CLIENT_ORIGIN }));

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
}
const sessions = new Map<string, SessionData>();

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
      io.to(`user:${uid}`).emit('worker-status', { status: 'offline' });
      console.log(`❌ Worker disconnected for User ${uid}`);
    });

    socket.on('output', (data: { sessionId: string; data: string }) => {
        // Forward output to the specific session room (which the client joined)
        io.to(data.sessionId).emit('output', data);
    });
  }

  if (role === 'client') {
    // Client joins their own "User Room" to get status updates
    socket.join(`user:${uid}`);

    // Check if they have a worker online
    const workerSocketId = userWorkers.get(uid);
    socket.emit('worker-status', { status: workerSocketId ? 'online' : 'offline' });

    socket.on('create-session', () => {
        const workerId = userWorkers.get(uid);
        if (!workerId) {
            return socket.emit('error', 'No worker available');
        }

        const sessionId = `sess_${uid}_${Date.now()}`;
        sessions.set(sessionId, {
            ownerUid: uid,
            workerSocketId: workerId,
            output: ''
        });

        socket.join(sessionId); // Client joins session room

        // Tell worker to spawn a shell
        io.to(workerId).emit('execute', { 
            sessionId, 
            command: '' // Empty command triggers spawn
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
  }
});

const PORT = parseInt(process.env.PORT || '3002');
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Hub Service running on port ${PORT}`);
});
