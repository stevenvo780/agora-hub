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