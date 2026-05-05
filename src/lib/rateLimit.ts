export interface RateLimitDecision {
  ok: boolean;
  retryAfterMs: number;
}

interface SlidingWindowRateLimiterOptions {
  windowMs: number;
  maxPerWindow: number;
}

export function createSlidingWindowRateLimiter({ windowMs, maxPerWindow }: SlidingWindowRateLimiterOptions) {
  const history = new Map<string, number[]>();

  const evictionInterval = setInterval(() => {
    const nowMs = Date.now();
    const cutoff = nowMs - windowMs * 2;
    for (const [key, timestamps] of history) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1]! < cutoff) {
        history.delete(key);
      }
    }
  }, 60_000);
  evictionInterval.unref();

  return {
    check(key: string, nowMs = Date.now()): RateLimitDecision {
      const previous = history.get(key) ?? [];
      const recent = previous.filter((timestamp) => nowMs - timestamp < windowMs);
      if (recent.length >= maxPerWindow) {
        const earliest = recent[0]!;
        return { ok: false, retryAfterMs: windowMs - (nowMs - earliest) };
      }
      recent.push(nowMs);
      history.set(key, recent);
      return { ok: true, retryAfterMs: 0 };
    },

    reset(key?: string): void {
      if (key) {
        history.delete(key);
        return;
      }
      history.clear();
    }
  };
}