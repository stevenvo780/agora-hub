import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectPendingAgentCommandsForWorker,
  resolvePendingAgentCommandResult
} from '../src/agentCommands';
import { pendingAgentCommands, type AgentCommandResultPayload } from '../src/state';

test('resolvePendingAgentCommandResult resuelve y limpia solo si worker/workspace coinciden', async () => {
  pendingAgentCommands.clear();
  const timeout = setTimeout(() => undefined, 30_000);
  const payload: AgentCommandResultPayload = {
    requestId: 'req-1',
    workspaceId: 'workspace-1',
    ok: true,
    command: 'pwd',
    cwd: '.',
    stdout: '/workspace',
    stderr: '',
    exitCode: 0,
    durationMs: 10
  };

  const resolved = new Promise<AgentCommandResultPayload>((resolve, reject) => {
    pendingAgentCommands.set('req-1', {
      workspaceId: 'workspace-1',
      workerSocketId: 'worker-1',
      resolve,
      reject,
      timeout
    });
  });

  assert.equal(resolvePendingAgentCommandResult(payload, 'worker-2', 'workspace-1'), false);
  assert.equal(pendingAgentCommands.has('req-1'), true);
  assert.equal(resolvePendingAgentCommandResult(payload, 'worker-1', 'workspace-1'), true);
  assert.equal(pendingAgentCommands.has('req-1'), false);
  assert.deepEqual(await resolved, payload);
});

test('rejectPendingAgentCommandsForWorker cancela comandos pendientes del worker desconectado', async () => {
  pendingAgentCommands.clear();
  const timeout = setTimeout(() => undefined, 30_000);
  const rejected = new Promise<Error>((resolve) => {
    pendingAgentCommands.set('req-2', {
      workspaceId: 'workspace-1',
      workerSocketId: 'worker-1',
      resolve: () => undefined,
      reject: resolve,
      timeout
    });
  });
  pendingAgentCommands.set('req-other', {
    workspaceId: 'workspace-2',
    workerSocketId: 'worker-2',
    resolve: () => undefined,
    reject: () => undefined,
    timeout: setTimeout(() => undefined, 30_000)
  });

  assert.equal(rejectPendingAgentCommandsForWorker('worker-1', 'worker offline'), 1);
  assert.equal(pendingAgentCommands.has('req-2'), false);
  assert.equal(pendingAgentCommands.has('req-other'), true);
  assert.match((await rejected).message, /worker offline/);

  clearTimeout(pendingAgentCommands.get('req-other')?.timeout);
  pendingAgentCommands.clear();
});
