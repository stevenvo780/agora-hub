import test from 'node:test';
import assert from 'node:assert/strict';

process.env.WORKER_SECRET = process.env.WORKER_SECRET || 'test-worker-secret';

test('canUserAccessWorkspace resuelve personal workspace sin tocar Firestore', async () => {
  const mod = await import('../src/auth');
  mod.clearWorkspaceAccessCacheForTesting();

  assert.equal(await mod.canUserAccessWorkspace('personal:user-1', 'user-1'), true);
  assert.equal(await mod.canUserAccessWorkspace('personal:user-1', 'user-2'), false);
  assert.equal(mod.workspaceAccessCacheSizeForTesting(), 0);
});
