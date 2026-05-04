import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkerTokenSecrets, resolveActiveWorkerSecret } from '../src/lib/workerSecrets';

test('resolveActiveWorkerSecret prefiere WORKER_SOCKET_SECRET y conserva fallback legacy', () => {
  assert.equal(resolveActiveWorkerSecret({
    WORKER_SOCKET_SECRET: ' socket ',
    WORKER_SECRET: ' legacy '
  }), 'socket');
  assert.equal(resolveActiveWorkerSecret({
    WORKER_SECRET: ' legacy '
  }), 'legacy');
});

test('getWorkerTokenSecrets agrega secreto previo sin duplicados para rotación', () => {
  assert.deepEqual(getWorkerTokenSecrets({
    WORKER_SOCKET_SECRET: 'socket',
    WORKER_SECRET: 'legacy',
    WORKER_SECRET_PREVIOUS: 'previous'
  }), ['socket', 'previous']);
  assert.deepEqual(getWorkerTokenSecrets({
    WORKER_SOCKET_SECRET: 'socket',
    WORKER_SECRET_PREVIOUS: 'socket'
  }), ['socket']);
});
