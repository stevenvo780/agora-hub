export interface WorkerSecretEnv {
  WORKER_SOCKET_SECRET?: string;
  WORKER_SECRET?: string;
  WORKER_SECRET_PREVIOUS?: string;
}

const clean = (value: string | undefined) => (value || '').trim();

export const resolveActiveWorkerSecret = (env: WorkerSecretEnv = process.env) => (
  clean(env.WORKER_SOCKET_SECRET) || clean(env.WORKER_SECRET)
);

export const getWorkerTokenSecrets = (env: WorkerSecretEnv = process.env) => Array.from(new Set([
  resolveActiveWorkerSecret(env),
  clean(env.WORKER_SECRET_PREVIOUS)
].filter(Boolean)));
