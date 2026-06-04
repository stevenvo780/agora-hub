import { Socket } from 'socket.io';

// ── Types ────────────────────────────────────────────────────────

export interface WorkerInfo {
  socketId: string;
  socket: Socket;
  workspaceType: 'personal' | 'shared';
  ownerId?: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  metrics?: WorkerRuntimeMetrics;
}

export interface WorkerRuntimeMetrics {
  activeSessions?: number;
  syncLagMs?: number | null;
  lastOperationAt?: number | null;
  consecutiveErrors?: number;
  version?: string;
}

export interface SessionData {
  ownerUid: string;
  workerSocketId: string;
  workspaceId: string;
  workspaceName?: string;
  workspaceType: 'personal' | 'shared';
  sessionName?: string;
  outputChunks: string[];
  outputSize: number;
}

export interface AgentCommandResultPayload {
  requestId: string;
  workspaceId: string;
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  durationMs: number;
}

// ── In-memory state ──────────────────────────────────────────────

export const workersByWorkspace = new Map<string, WorkerInfo>();

export const sessions = new Map<string, SessionData>();

/** Reverse index: workerSocketId → Set<sessionId> for O(1) lookup on worker disconnect */
export const sessionsByWorker = new Map<string, Set<string>>();

export const pendingAgentCommands = new Map<string, {
  workspaceId: string;
  workerSocketId: string;
  resolve: (payload: AgentCommandResultPayload) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

export const pendingStatusNotifications = new Map<string, NodeJS.Timeout>();

/** workspaceId → timer de gracia. Al caerse un worker NO terminamos sus sesiones
 *  de inmediato: su PTY sigue vivo. Damos una ventana para que reconecte y
 *  re-attachee (tipo tmux); sólo si la gracia expira se terminan las sesiones. */
export const workerDisconnectGrace = new Map<string, NodeJS.Timeout>();

// ── Constants ────────────────────────────────────────────────────

export const STATUS_DEBOUNCE_MS = 2000;
export const WORKER_DISCONNECT_GRACE_MS = 120_000; // gracia para reconexión de worker antes de terminar sesiones
export const MAX_HISTORY_BUFFER = 500_000; // 500KB buffer per session
