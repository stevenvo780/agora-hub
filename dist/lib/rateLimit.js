"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSlidingWindowRateLimiter = createSlidingWindowRateLimiter;
function createSlidingWindowRateLimiter({ windowMs, maxPerWindow }) {
    const history = new Map();
    return {
        check(key, nowMs = Date.now()) {
            const previous = history.get(key) ?? [];
            const recent = previous.filter((timestamp) => nowMs - timestamp < windowMs);
            if (recent.length >= maxPerWindow) {
                const earliest = recent[0];
                return { ok: false, retryAfterMs: windowMs - (nowMs - earliest) };
            }
            recent.push(nowMs);
            history.set(key, recent);
            return { ok: true, retryAfterMs: 0 };
        },
        reset(key) {
            if (key) {
                history.delete(key);
                return;
            }
            history.clear();
        }
    };
}
