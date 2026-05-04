"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeAgentCommandRequestId = makeAgentCommandRequestId;
exports.resolvePendingAgentCommandResult = resolvePendingAgentCommandResult;
exports.rejectPendingAgentCommandsForWorker = rejectPendingAgentCommandsForWorker;
const crypto = __importStar(require("crypto"));
const state_1 = require("./state");
function makeAgentCommandRequestId(workspaceId, now = Date.now()) {
    return `agent_${workspaceId.replace(/[^a-zA-Z0-9]/g, '_')}_${now}_${crypto.randomBytes(4).toString('hex')}`;
}
function resolvePendingAgentCommandResult(payload, workerSocketId, workspaceId) {
    const pending = state_1.pendingAgentCommands.get(payload.requestId);
    if (!pending || pending.workerSocketId !== workerSocketId || pending.workspaceId !== workspaceId) {
        return false;
    }
    clearTimeout(pending.timeout);
    state_1.pendingAgentCommands.delete(payload.requestId);
    pending.resolve(payload);
    return true;
}
function rejectPendingAgentCommandsForWorker(workerSocketId, reason) {
    let rejected = 0;
    for (const [requestId, pending] of state_1.pendingAgentCommands.entries()) {
        if (pending.workerSocketId !== workerSocketId)
            continue;
        clearTimeout(pending.timeout);
        state_1.pendingAgentCommands.delete(requestId);
        pending.reject(new Error(reason));
        rejected++;
    }
    return rejected;
}
