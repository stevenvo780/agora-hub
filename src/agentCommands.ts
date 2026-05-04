import * as crypto from 'crypto';
import {
  pendingAgentCommands,
  type AgentCommandResultPayload
} from './state';

export function makeAgentCommandRequestId(workspaceId: string, now = Date.now()): string {
  return `agent_${workspaceId.replace(/[^a-zA-Z0-9]/g, '_')}_${now}_${crypto.randomBytes(4).toString('hex')}`;
}

export function resolvePendingAgentCommandResult(
  payload: AgentCommandResultPayload,
  workerSocketId: string,
  workspaceId: string
): boolean {
  const pending = pendingAgentCommands.get(payload.requestId);
  if (!pending || pending.workerSocketId !== workerSocketId || pending.workspaceId !== workspaceId) {
    return false;
  }
  clearTimeout(pending.timeout);
  pendingAgentCommands.delete(payload.requestId);
  pending.resolve(payload);
  return true;
}

export function rejectPendingAgentCommandsForWorker(workerSocketId: string, reason: string): number {
  let rejected = 0;
  for (const [requestId, pending] of pendingAgentCommands.entries()) {
    if (pending.workerSocketId !== workerSocketId) continue;
    clearTimeout(pending.timeout);
    pendingAgentCommands.delete(requestId);
    pending.reject(new Error(reason));
    rejected++;
  }
  return rejected;
}
