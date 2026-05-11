import * as admin from 'firebase-admin';
import express from 'express';
import {
  isPersonalWorkspaceToken,
  getPersonalWorkspaceOwnerId,
  verifyWorkerToken as verifySignedWorkerToken,
  parseLegacyWorkerToken
} from './lib/workerToken';
import { getWorkerTokenSecrets, resolveActiveWorkerSecret } from './lib/workerSecrets';

// ── Config ───────────────────────────────────────────────────────

export const WORKER_SECRET = resolveActiveWorkerSecret();
export const WORKER_SECRET_PREVIOUS = (process.env.WORKER_SECRET_PREVIOUS || '').trim();
export const ALLOW_LEGACY_WORKER_TOKENS = process.env.ALLOW_LEGACY_WORKER_TOKENS === 'true';
export const WORKER_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const WORKSPACE_ACCESS_CACHE_TTL = 60_000;

if (!WORKER_SECRET) {
  console.error('WORKER_SOCKET_SECRET or WORKER_SECRET is required.');
  process.exit(1);
}

// ── Workspace access cache ───────────────────────────────────────

const workspaceAccessCache = new Map<string, { result: boolean; expiresAt: number }>();

const cacheEvictionInterval = setInterval(() => {
  const nowMs = Date.now();
  for (const [key, entry] of workspaceAccessCache) {
    if (entry.expiresAt <= nowMs) {
      workspaceAccessCache.delete(key);
    }
  }
}, 60_000);
cacheEvictionInterval.unref();

export const canUserAccessWorkspace = async (workspaceId: string, uid: string): Promise<boolean> => {
  if (!workspaceId || !uid) return false;
  if (isPersonalWorkspaceToken(workspaceId)) {
    return getPersonalWorkspaceOwnerId(workspaceId) === uid;
  }

  const cacheKey = `${workspaceId}:${uid}`;
  const cached = workspaceAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const snap = await admin.firestore().collection('workspaces').doc(workspaceId).get();
    const result = snap.exists && Array.isArray((snap.data() as { members?: unknown } | undefined)?.members)
      && (snap.data() as { members: unknown[] }).members.includes(uid);
    workspaceAccessCache.set(cacheKey, { result, expiresAt: Date.now() + WORKSPACE_ACCESS_CACHE_TTL });
    return result;
  } catch (error) {
    // Si Firestore RPC falla (credenciales rotas, red, etc.) no cacheamos el
    // false: queremos reintentar en la próxima subscribe. Log explícito para
    // diagnóstico — antes este throw quedaba silencioso porque el handler
    // socket.on(async) descartaba la rejected promise sin trace.
    console.error(`[auth] canUserAccessWorkspace(${workspaceId}, ${uid}) failed:`, error instanceof Error ? error.message : error);
    return false;
  }
};

export const clearWorkspaceAccessCacheForTesting = () => {
  workspaceAccessCache.clear();
};

export const workspaceAccessCacheSizeForTesting = () => workspaceAccessCache.size;

// ── Session access ───────────────────────────────────────────────

import type { SessionData } from './state';

export const canUserAccessSession = async (session: SessionData, uid: string): Promise<boolean> => {
  if (session.ownerUid === uid) return true;
  return canUserAccessWorkspace(session.workspaceId, uid);
};

// ── Admin check ──────────────────────────────────────────────────

export const isAdminUser = async (uid: string): Promise<boolean> => {
  if (!uid) return false;
  const snap = await admin.firestore().collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const data = snap.data() as { role?: unknown } | undefined;
  return typeof data?.role === 'string' && ['admin', 'superadmin'].includes(data.role.toLowerCase());
};

// ── HTTP token extraction ────────────────────────────────────────

export const authenticateHttpUser = async (req: express.Request, res: express.Response): Promise<admin.auth.DecodedIdToken | null> => {
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

// ── Worker token verification ────────────────────────────────────

export function verifyWorkerToken(token: string): { workspaceId: string; workspaceType: 'personal' | 'shared'; ownerId?: string } | null {
  for (const secret of getWorkerTokenSecrets({
    WORKER_SECRET,
    WORKER_SECRET_PREVIOUS
  })) {
    const parsed = verifySignedWorkerToken(token, {
      secret,
      allowLegacy: false,
      maxAgeMs: WORKER_TOKEN_MAX_AGE_MS
    });
    if (parsed) return parsed;
  }

  if (ALLOW_LEGACY_WORKER_TOKENS) {
    const legacyParsed = parseLegacyWorkerToken(token);
    if (legacyParsed) {
      console.warn(`⚠️ Legacy token format used for workspace: ${legacyParsed.workspaceId} - Please update worker`);
      return legacyParsed;
    }
  }
  return null;
}
