import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStaleWorkers, recordWorkerHeartbeat } from '../src/workers';
import { workersByWorkspace } from '../src/state';

const fakeSocket = () => {
  let disconnected = false;
  return {
    get disconnected() { return disconnected; },
    socket: {
      connected: true,
      disconnect: () => {
        disconnected = true;
      }
    }
  };
};

test('recordWorkerHeartbeat actualiza timestamp y métricas', () => {
  workersByWorkspace.clear();
  const fake = fakeSocket();
  workersByWorkspace.set('workspace-1', {
    socketId: 'socket-1',
    socket: fake.socket as never,
    workspaceType: 'shared',
    connectedAt: 1000,
    lastHeartbeatAt: 1000
  });

  assert.equal(recordWorkerHeartbeat('workspace-1', {
    activeSessions: 2,
    syncLagMs: 50,
    consecutiveErrors: 1,
    version: '1.0.0'
  }, 2000), true);

  const worker = workersByWorkspace.get('workspace-1');
  assert.equal(worker?.lastHeartbeatAt, 2000);
  assert.equal(worker?.metrics?.activeSessions, 2);
  assert.equal(worker?.metrics?.syncLagMs, 50);
});

test('cleanupStaleWorkers desconecta workers sin heartbeat reciente', () => {
  workersByWorkspace.clear();
  const stale = fakeSocket();
  const fresh = fakeSocket();
  workersByWorkspace.set('stale', {
    socketId: 'socket-stale',
    socket: stale.socket as never,
    workspaceType: 'shared',
    connectedAt: 0,
    lastHeartbeatAt: 0
  });
  workersByWorkspace.set('fresh', {
    socketId: 'socket-fresh',
    socket: fresh.socket as never,
    workspaceType: 'shared',
    connectedAt: 9_900,
    lastHeartbeatAt: 9_900
  });

  assert.equal(cleanupStaleWorkers(10_000, 5_000), 1);
  assert.equal(stale.disconnected, true);
  assert.equal(fresh.disconnected, false);
  workersByWorkspace.clear();
});
