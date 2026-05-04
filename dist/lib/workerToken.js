"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkspaceTypeFromId = exports.getPersonalWorkspaceOwnerId = exports.isPersonalWorkspaceToken = void 0;
exports.parseLegacyWorkerToken = parseLegacyWorkerToken;
exports.signWorkerTokenPayload = signWorkerTokenPayload;
exports.createSignedWorkerToken = createSignedWorkerToken;
exports.verifyWorkerToken = verifyWorkerToken;
const crypto_1 = require("crypto");
const PERSONAL_WORKSPACE_PREFIX = 'personal:';
const isPersonalWorkspaceToken = (workspaceId) => workspaceId.startsWith(PERSONAL_WORKSPACE_PREFIX);
exports.isPersonalWorkspaceToken = isPersonalWorkspaceToken;
const getPersonalWorkspaceOwnerId = (workspaceId) => ((0, exports.isPersonalWorkspaceToken)(workspaceId) ? workspaceId.slice(PERSONAL_WORKSPACE_PREFIX.length) : null);
exports.getPersonalWorkspaceOwnerId = getPersonalWorkspaceOwnerId;
const getWorkspaceTypeFromId = (workspaceId) => ((0, exports.isPersonalWorkspaceToken)(workspaceId) ? 'personal' : 'shared');
exports.getWorkspaceTypeFromId = getWorkspaceTypeFromId;
function parseLegacyWorkerToken(token) {
    if (!token || token.includes('.'))
        return null;
    if (token.startsWith(PERSONAL_WORKSPACE_PREFIX)) {
        const ownerId = token.substring(PERSONAL_WORKSPACE_PREFIX.length);
        if (!ownerId)
            return null;
        return { workspaceId: token, workspaceType: 'personal', ownerId };
    }
    return { workspaceId: token, workspaceType: 'shared' };
}
function signWorkerTokenPayload(secret, payloadB64) {
    return (0, crypto_1.createHmac)('sha256', secret).update(payloadB64).digest('hex');
}
function createSignedWorkerToken(secret, payload) {
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return `${payloadB64}.${signWorkerTokenPayload(secret, payloadB64)}`;
}
function verifyWorkerToken(token, options) {
    const { secret, allowLegacy = false, nowMs = Date.now(), maxAgeMs = 5 * 60 * 1000 } = options;
    try {
        const [payloadB64, signature] = token.split('.');
        if (payloadB64 && signature && secret) {
            const expectedSignature = signWorkerTokenPayload(secret, payloadB64);
            const signaturesMatch = signature.length === expectedSignature.length
                && (0, crypto_1.timingSafeEqual)(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
            if (signaturesMatch) {
                const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
                if (typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim())
                    return null;
                const workspaceId = payload.workspaceId.trim();
                const workspaceType = (0, exports.getWorkspaceTypeFromId)(workspaceId);
                const ownerId = typeof payload.ownerId === 'string' && payload.ownerId.trim()
                    ? payload.ownerId.trim()
                    : undefined;
                const personalOwnerId = (0, exports.getPersonalWorkspaceOwnerId)(workspaceId);
                if (workspaceType === 'personal' && ownerId !== personalOwnerId)
                    return null;
                if (payload.workspaceType !== workspaceType)
                    return null;
                if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp))
                    return null;
                const ageMs = nowMs - payload.timestamp;
                if (ageMs < -10000 || ageMs > maxAgeMs)
                    return null;
                return { workspaceId, workspaceType, ownerId };
            }
        }
    }
    catch (_error) {
        return null;
    }
    return allowLegacy ? parseLegacyWorkerToken(token) : null;
}
