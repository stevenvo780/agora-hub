"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSlidingWindowRateLimiter = createSlidingWindowRateLimiter;
function createSlidingWindowRateLimiter({ windowMs, maxPerWindow }) {
    const history = new Map();
    const evictionInterval = setInterval(() => {
        const nowMs = Date.now();
        const cutoff = nowMs - windowMs * 2;
        for (const [key, timestamps] of history) {
            if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
                history.delete(key);
            }
        }
    }, 60000);
    evictionInterval.unref();
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
