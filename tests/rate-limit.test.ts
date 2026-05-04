import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlidingWindowRateLimiter } from '../src/lib/rateLimit';

test('rate limiter permite hasta maxPerWindow por llave', () => {
  const limiter = createSlidingWindowRateLimiter({ windowMs: 30_000, maxPerWindow: 2 });

  assert.deepEqual(limiter.check('ws-1', 1000), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check('ws-1', 2000), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check('ws-1', 3000), { ok: false, retryAfterMs: 28_000 });
});

test('rate limiter aísla llaves y libera ventana al expirar', () => {
  const limiter = createSlidingWindowRateLimiter({ windowMs: 10_000, maxPerWindow: 1 });

  assert.equal(limiter.check('ws-1', 1000).ok, true);
  assert.equal(limiter.check('ws-2', 1000).ok, true);
  assert.equal(limiter.check('ws-1', 5000).ok, false);
  assert.equal(limiter.check('ws-1', 11_001).ok, true);
});

test('rate limiter puede resetear una llave o todo el estado', () => {
  const limiter = createSlidingWindowRateLimiter({ windowMs: 10_000, maxPerWindow: 1 });

  limiter.check('ws-1', 1000);
  limiter.check('ws-2', 1000);
  limiter.reset('ws-1');
  assert.equal(limiter.check('ws-1', 2000).ok, true);
  assert.equal(limiter.check('ws-2', 2000).ok, false);
  limiter.reset();
  assert.equal(limiter.check('ws-2', 3000).ok, true);
});