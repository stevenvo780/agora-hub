import { createHmac, timingSafeEqual } from 'crypto';

const PERSONAL_WORKSPACE_PREFIX = 'personal:';

export interface WorkerTokenPayload {
  workspaceId: string;
  workspaceType: 'personal' | 'shared';
  ownerId?: string;
}

interface VerifyWorkerTokenOptions {
  secret: string;
  allowLegacy?: boolean;
  nowMs?: number;
  maxAgeMs?: number;
}

export const isPersonalWorkspaceToken = (workspaceId: string) => workspaceId.startsWith(PERSONAL_WORKSPACE_PREFIX);

export const getPersonalWorkspaceOwnerId = (workspaceId: string) => (
  isPersonalWorkspaceToken(workspaceId) ? workspaceId.slice(PERSONAL_WORKSPACE_PREFIX.length) : null
);

export const getWorkspaceTypeFromId = (workspaceId: string): 'personal' | 'shared' => (
  isPersonalWorkspaceToken(workspaceId) ? 'personal' : 'shared'
);

export function parseLegacyWorkerToken(token: string): WorkerTokenPayload | null {
  if (!token || token.includes('.')) return null;
  if (token.startsWith(PERSONAL_WORKSPACE_PREFIX)) {
    const ownerId = token.substring(PERSONAL_WORKSPACE_PREFIX.length);
    if (!ownerId) return null;
    return { workspaceId: token, workspaceType: 'personal', ownerId };
  }
  return { workspaceId: token, workspaceType: 'shared' };
}

export function signWorkerTokenPayload(secret: string, payloadB64: string) {
  return createHmac('sha256', secret).update(payloadB64).digest('hex');
}

export function createSignedWorkerToken(secret: string, payload: WorkerTokenPayload & { timestamp: number }) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${payloadB64}.${signWorkerTokenPayload(secret, payloadB64)}`;
}

export function verifyWorkerToken(token: string, options: VerifyWorkerTokenOptions): WorkerTokenPayload | null {
  const { secret, allowLegacy = false, nowMs = Date.now(), maxAgeMs = 5 * 60 * 1000 } = options;
  try {
    const [payloadB64, signature] = token.split('.');
    if (payloadB64 && signature && secret) {
      const expectedSignature = signWorkerTokenPayload(secret, payloadB64);
      const signaturesMatch = signature.length === expectedSignature.length
        && timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
      if (signaturesMatch) {
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

        const ageMs = nowMs - payload.timestamp;
        if (ageMs < -10_000 || ageMs > maxAgeMs) return null;

        return { workspaceId, workspaceType, ownerId };
      }
    }
  } catch (_error) {
    return null;
  }

  return allowLegacy ? parseLegacyWorkerToken(token) : null;
}