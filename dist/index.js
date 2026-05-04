"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const https_1 = require("https");
const fs_1 = require("fs");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const admin = __importStar(require("firebase-admin"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
if (!admin.apps.length) {
    try {
        let serviceAccount = null;
        const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credentialsPath && (0, fs_1.existsSync)(credentialsPath)) {
            try {
                const fileContent = (0, fs_1.readFileSync)(credentialsPath, 'utf-8');
                serviceAccount = JSON.parse(fileContent);
                console.log('🔑 Loaded credentials from file:', credentialsPath);
            }
            catch (fileError) {
                console.warn('Failed to read GOOGLE_APPLICATION_CREDENTIALS file:', fileError);
            }
        }
        if (!serviceAccount) {
            const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (serviceAccountRaw) {
                try {
                    serviceAccount = JSON.parse(serviceAccountRaw);
                    console.log('🔑 Loaded credentials from FIREBASE_SERVICE_ACCOUNT env');
                }
                catch (_parseError) {
                    try {
                        const decoded = Buffer.from(serviceAccountRaw, 'base64').toString('utf-8');
                        serviceAccount = JSON.parse(decoded);
                        console.log('🔑 Loaded credentials from FIREBASE_SERVICE_ACCOUNT (base64)');
                    }
                    catch (_decodeError) {
                        console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials.');
                    }
                }
            }
        }
        if (serviceAccount) {
            const serviceAccountWithProjectId = serviceAccount;
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                projectId: process.env.FIREBASE_PROJECT_ID || serviceAccountWithProjectId.project_id
            });
        }
        else {
            admin.initializeApp();
        }
        console.log('🔥 Firebase Admin initialized');
    }
    catch (error) {
        console.error('Firebase Admin init failed:', error);
    }
}
// ── Express + CORS ───────────────────────────────────────────────
const app = (0, express_1.default)();
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin)
            return callback(null, true);
        try {
            const originUrl = new URL(origin);
            if (CLIENT_ORIGINS.some(allowed => origin === allowed || allowed === originUrl.origin)) {
                return callback(null, true);
            }
        }
        catch (e) {
            // Invalid origin URL
        }
        console.warn(`⚠️ CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST']
};
app.use((0, cors_1.default)(corsOptions));
app.use(express_1.default.json({ limit: '1mb' }));
// ── HTTP(S) Server ───────────────────────────────────────────────
let httpServer;
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;
if (sslKeyPath && sslCertPath && (0, fs_1.existsSync)(sslKeyPath) && (0, fs_1.existsSync)(sslCertPath)) {
    console.log('🔒 Initializing secure HTTPS server...');
    try {
        const httpsOptions = {
            key: (0, fs_1.readFileSync)(sslKeyPath),
            cert: (0, fs_1.readFileSync)(sslCertPath)
        };
        httpServer = (0, https_1.createServer)(httpsOptions, app);
        console.log('✅ HTTPS Server Created');
    }
    catch (e) {
        console.error('❌ Failed to create SSL server, falling back to HTTP', e);
        httpServer = (0, http_1.createServer)(app);
    }
}
else {
    console.log('⚠️ No SSL keys found, initializing insecure HTTP server...');
    httpServer = (0, http_1.createServer)(app);
}
// ── Socket.io ────────────────────────────────────────────────────
const io = new socket_io_1.Server(httpServer, {
    cors: corsOptions
});
// ── Register modules ─────────────────────────────────────────────
const socketHandlers_1 = require("./socketHandlers");
const routes_1 = require("./routes");
const workers_1 = require("./workers");
(0, socketHandlers_1.registerAuthMiddleware)(io);
(0, socketHandlers_1.registerConnectionHandlers)(io);
(0, routes_1.registerRoutes)(app, io);
(0, workers_1.startWorkerHeartbeatMonitor)(io);
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
        }
        catch (error) {
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
