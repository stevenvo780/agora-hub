"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkerTokenSecrets = exports.resolveActiveWorkerSecret = void 0;
const clean = (value) => (value || '').trim();
const resolveActiveWorkerSecret = (env = process.env) => (clean(env.WORKER_SOCKET_SECRET) || clean(env.WORKER_SECRET));
exports.resolveActiveWorkerSecret = resolveActiveWorkerSecret;
const getWorkerTokenSecrets = (env = process.env) => Array.from(new Set([
    (0, exports.resolveActiveWorkerSecret)(env),
    clean(env.WORKER_SECRET_PREVIOUS)
].filter(Boolean)));
exports.getWorkerTokenSecrets = getWorkerTokenSecrets;
