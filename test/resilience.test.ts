import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-resil-'));
process.env.WHATSAPPMAN_DIR = dir;

const { computeBackoff } = await import('../src/daemon/session-manager.ts');
const { RateLimiter } = await import('../src/daemon/rate-limit.ts');

test('computeBackoff: base, doubles, caps', () => {
  assert.equal(computeBackoff(1, 3000, 60000), 3000);
  assert.equal(computeBackoff(2, 3000, 60000), 6000);
  assert.equal(computeBackoff(3, 3000, 60000), 12000);
  assert.equal(computeBackoff(4, 3000, 60000), 24000);
  assert.equal(computeBackoff(5, 3000, 60000), 48000);
  assert.equal(computeBackoff(6, 3000, 60000), 60000); // capped
  assert.equal(computeBackoff(20, 3000, 60000), 60000); // still capped, no overflow
});

test('RateLimiter: allows a burst up to capacity, then blocks', () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), false); // 4th in the same instant → blocked
  assert.ok(rl.retryAfterSec('work', t0) >= 1);
});

test('RateLimiter: refills over time', () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
  const t0 = 2_000_000;
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), false);
  // 2 seconds later → 2 tokens back.
  assert.equal(rl.tryConsume('work', t0 + 2000), true);
  assert.equal(rl.tryConsume('work', t0 + 2000), true);
  assert.equal(rl.tryConsume('work', t0 + 2000), false);
});

test('RateLimiter: buckets are per-key (per session)', () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
  const t0 = 3_000_000;
  assert.equal(rl.tryConsume('work', t0), true);
  assert.equal(rl.tryConsume('work', t0), false);
  // A different session has its own fresh bucket.
  assert.equal(rl.tryConsume('personal', t0), true);
});
