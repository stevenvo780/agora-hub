import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { Server } from 'socket.io';
import cors from 'cors';
import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// ── Firebase Admin init ──────────────────────────────────────────

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

// ── Express + CORS ───────────────────────────────────────────────

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

// ── HTTP(S) Server ───────────────────────────────────────────────

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

// ── Socket.io ────────────────────────────────────────────────────

const io = new Server(httpServer, {
  cors: corsOptions
});

// ── Register modules ─────────────────────────────────────────────

import { registerAuthMiddleware, registerConnectionHandlers } from './socketHandlers';
import { registerRoutes } from './routes';
import { startWorkerHeartbeatMonitor } from './workers';

registerAuthMiddleware(io);
registerConnectionHandlers(io);
registerRoutes(app, io);
startWorkerHeartbeatMonitor(io);

// ── Start server ─────────────────────────────────────────────────

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
