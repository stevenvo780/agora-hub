import test from 'node:test';
import assert from 'node:assert/strict';
import { endSessionsByWorker } from '../src/sessions';
import { sessions, sessionsByWorker } from '../src/state';

test('endSessionsByWorker limpia sesiones e índice inverso', () => {
  sessions.clear();
  sessionsByWorker.clear();
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload });
        }
      };
    }
  };

  sessions.set('sess-1', {
    ownerUid: 'user-1',
    workerSocketId: 'worker-1',
    workspaceId: 'workspace-1',
    workspaceType: 'shared',
    outputChunks: [],
    outputSize: 0
  });
  sessionsByWorker.set('worker-1', new Set(['sess-1']));

  endSessionsByWorker(io as never, 'worker-1', 'worker-disconnected');

  assert.equal(sessions.has('sess-1'), false);
  assert.equal(sessionsByWorker.has('worker-1'), false);
  assert.equal(emitted.some(item => item.event === 'session-ended'), true);
});
