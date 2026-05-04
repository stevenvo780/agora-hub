import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedWorkerToken,
  parseLegacyWorkerToken,
  verifyWorkerToken
} from '../src/lib/workerToken';

test('verifica token firmado de workspace shared', () => {
  const nowMs = 1_700_000_000_000;
  const token = createSignedWorkerToken('worker-secret', {
    workspaceId: 'workspace-1',
    workspaceType: 'shared',
    timestamp: nowMs
  });

  assert.deepEqual(verifyWorkerToken(token, { secret: 'worker-secret', nowMs }), {
    workspaceId: 'workspace-1',
    workspaceType: 'shared',
    ownerId: undefined
  });
});

test('rechaza token personal con ownerId inconsistente', () => {
  const nowMs = 1_700_000_000_000;
  const token = createSignedWorkerToken('worker-secret', {
    workspaceId: 'personal:user-1',
    workspaceType: 'personal',
    ownerId: 'user-2',
    timestamp: nowMs
  });

  assert.equal(verifyWorkerToken(token, { secret: 'worker-secret', nowMs }), null);
});

test('rechaza token vencido y firma alterada', () => {
  const nowMs = 1_700_000_000_000;
  const token = createSignedWorkerToken('worker-secret', {
    workspaceId: 'workspace-1',
    workspaceType: 'shared',
    timestamp: nowMs - 301_000
  });

  assert.equal(verifyWorkerToken(token, { secret: 'worker-secret', nowMs }), null);
  assert.equal(verifyWorkerToken(`${token.slice(0, -1)}0`, { secret: 'worker-secret', nowMs }), null);
});

test('legacy worker token sólo se acepta cuando está habilitado', () => {
  assert.deepEqual(parseLegacyWorkerToken('personal:user-1'), {
    workspaceId: 'personal:user-1',
    workspaceType: 'personal',
    ownerId: 'user-1'
  });
  assert.equal(verifyWorkerToken('workspace-1', { secret: 'worker-secret', allowLegacy: false }), null);
  assert.deepEqual(verifyWorkerToken('workspace-1', { secret: 'worker-secret', allowLegacy: true }), {
    workspaceId: 'workspace-1',
    workspaceType: 'shared'
  });
});