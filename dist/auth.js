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
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateHttpUser = exports.isAdminUser = exports.canUserAccessSession = exports.workspaceAccessCacheSizeForTesting = exports.clearWorkspaceAccessCacheForTesting = exports.canUserAccessWorkspace = exports.WORKER_TOKEN_MAX_AGE_MS = exports.ALLOW_LEGACY_WORKER_TOKENS = exports.WORKER_SECRET_PREVIOUS = exports.WORKER_SECRET = void 0;
exports.verifyWorkerToken = verifyWorkerToken;
const admin = __importStar(require("firebase-admin"));
const workerToken_1 = require("./lib/workerToken");
const workerSecrets_1 = require("./lib/workerSecrets");
// ── Config ───────────────────────────────────────────────────────
exports.WORKER_SECRET = (0, workerSecrets_1.resolveActiveWorkerSecret)();
exports.WORKER_SECRET_PREVIOUS = (process.env.WORKER_SECRET_PREVIOUS || '').trim();
exports.ALLOW_LEGACY_WORKER_TOKENS = process.env.ALLOW_LEGACY_WORKER_TOKENS === 'true';
exports.WORKER_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const WORKSPACE_ACCESS_CACHE_TTL = 60000;
if (!exports.WORKER_SECRET) {
    console.error('WORKER_SOCKET_SECRET or WORKER_SECRET is required.');
    process.exit(1);
}
// ── Workspace access cache ───────────────────────────────────────
const workspaceAccessCache = new Map();
const cacheEvictionInterval = setInterval(() => {
    const nowMs = Date.now();
    for (const [key, entry] of workspaceAccessCache) {
        if (entry.expiresAt <= nowMs) {
            workspaceAccessCache.delete(key);
        }
    }
}, 60000);
cacheEvictionInterval.unref();
const canUserAccessWorkspace = async (workspaceId, uid) => {
    if (!workspaceId || !uid)
        return false;
    if ((0, workerToken_1.isPersonalWorkspaceToken)(workspaceId)) {
        return (0, workerToken_1.getPersonalWorkspaceOwnerId)(workspaceId) === uid;
    }
    const cacheKey = `${workspaceId}:${uid}`;
    const cached = workspaceAccessCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
        return cached.result;
    const snap = await admin.firestore().collection('workspaces').doc(workspaceId).get();
    const result = snap.exists && Array.isArray(snap.data()?.members)
        && snap.data().members.includes(uid);
    workspaceAccessCache.set(cacheKey, { result, expiresAt: Date.now() + WORKSPACE_ACCESS_CACHE_TTL });
    return result;
};
exports.canUserAccessWorkspace = canUserAccessWorkspace;
const clearWorkspaceAccessCacheForTesting = () => {
    workspaceAccessCache.clear();
};
exports.clearWorkspaceAccessCacheForTesting = clearWorkspaceAccessCacheForTesting;
const workspaceAccessCacheSizeForTesting = () => workspaceAccessCache.size;
exports.workspaceAccessCacheSizeForTesting = workspaceAccessCacheSizeForTesting;
const canUserAccessSession = async (session, uid) => {
    if (session.ownerUid === uid)
        return true;
    return (0, exports.canUserAccessWorkspace)(session.workspaceId, uid);
};
exports.canUserAccessSession = canUserAccessSession;
// ── Admin check ──────────────────────────────────────────────────
const isAdminUser = async (uid) => {
    if (!uid)
        return false;
    const snap = await admin.firestore().collection('users').doc(uid).get();
    if (!snap.exists)
        return false;
    const data = snap.data();
    return typeof data?.role === 'string' && ['admin', 'superadmin'].includes(data.role.toLowerCase());
};
exports.isAdminUser = isAdminUser;
// ── HTTP token extraction ────────────────────────────────────────
const authenticateHttpUser = async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }
    try {
        return await admin.auth().verifyIdToken(token);
    }
    catch (_error) {
        res.status(403).json({ error: 'Forbidden' });
        return null;
    }
};
exports.authenticateHttpUser = authenticateHttpUser;
// ── Worker token verification ────────────────────────────────────
function verifyWorkerToken(token) {
    for (const secret of (0, workerSecrets_1.getWorkerTokenSecrets)({
        WORKER_SECRET: exports.WORKER_SECRET,
        WORKER_SECRET_PREVIOUS: exports.WORKER_SECRET_PREVIOUS
    })) {
        const parsed = (0, workerToken_1.verifyWorkerToken)(token, {
            secret,
            allowLegacy: false,
            maxAgeMs: exports.WORKER_TOKEN_MAX_AGE_MS
        });
        if (parsed)
            return parsed;
    }
    if (exports.ALLOW_LEGACY_WORKER_TOKENS) {
        const legacyParsed = (0, workerToken_1.parseLegacyWorkerToken)(token);
        if (legacyParsed) {
            console.warn(`⚠️ Legacy token format used for workspace: ${legacyParsed.workspaceId} - Please update worker`);
            return legacyParsed;
        }
    }
    return null;
}
