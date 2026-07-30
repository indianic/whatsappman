import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateBulk } = await import('../src/daemon/bulk.ts');
const { WhatsAppManError, ErrorCode } = await import('../src/errors.ts');

test('validateBulk accepts a list within the cap', () => {
  assert.doesNotThrow(() => validateBulk(['a', 'b', 'c'], 5));
  assert.doesNotThrow(() => validateBulk(['a'], 1));
});

test('validateBulk rejects an empty list', () => {
  assert.throws(
    () => validateBulk([], 5),
    (e: unknown) => e instanceof WhatsAppManError && e.code === ErrorCode.BAD_REQUEST,
  );
});

test('validateBulk rejects over the cap with BULK_LIMIT_EXCEEDED', () => {
  assert.throws(
    () => validateBulk(['a', 'b', 'c'], 2),
    (e: unknown) => e instanceof WhatsAppManError && e.code === ErrorCode.BULK_LIMIT_EXCEEDED,
  );
});

/**
 * Anti-ban behaviour. The cap and the delay were always here; these cover the
 * two additions that matter when WhatsApp starts pushing back mid-batch.
 */
const { withJitter, CONSECUTIVE_FAILURE_LIMIT } = await import('../src/daemon/bulk.ts');

test('withJitter spreads the delay ±25% so the cadence is not machine-perfect', () => {
  // rand() = 0 → the low end, 1 → the high end, 0.5 → unchanged.
  assert.equal(withJitter(2000, () => 0), 1500);
  assert.equal(withJitter(2000, () => 1), 2500);
  assert.equal(withJitter(2000, () => 0.5), 2000);
});

test('withJitter never returns a negative or nonsensical delay', () => {
  assert.equal(withJitter(0), 0, 'a zero delay stays zero — jitter must not invent one');
  for (let i = 0; i < 200; i++) {
    const v = withJitter(2000);
    assert.ok(v >= 1500 && v <= 2500, `jitter escaped its band: ${v}`);
  }
});

test('the circuit breaker trips on a short run of failures, not a single bad number', () => {
  // One dud number in a list is normal and must not stop the batch; a RUN of
  // failures is what throttling looks like, and continuing then risks a ban.
  assert.ok(CONSECUTIVE_FAILURE_LIMIT >= 2, 'a single failure must not abort a batch');
  assert.ok(CONSECUTIVE_FAILURE_LIMIT <= 5, 'waiting longer than this defeats the point');
});

const { BulkGuard } = await import('../src/daemon/bulk.ts');

test('BulkGuard keeps going through isolated failures', () => {
  // One dud number between good ones is normal list hygiene, not throttling.
  const g = new BulkGuard(3);
  g.recordFailure();
  g.recordSuccess();
  g.recordFailure();
  g.recordSuccess();
  g.recordFailure();
  assert.equal(g.isAborted, false, 'scattered failures must not stop a batch');
});

test('BulkGuard trips once failures run consecutively', () => {
  const g = new BulkGuard(3);
  g.recordFailure();
  g.recordFailure();
  assert.equal(g.isAborted, false, 'still under the limit');
  g.recordFailure();
  assert.equal(g.isAborted, true, 'a run of failures stops the batch');
  assert.match(g.aborted ?? '', /throttling/i, 'the reason must name the ban risk');
});

test('BulkGuard stays aborted and keeps its first reason', () => {
  // Later failures must not rewrite the message with a bigger count.
  const g = new BulkGuard(2);
  g.recordFailure();
  g.recordFailure();
  const first = g.aborted;
  g.recordFailure();
  assert.equal(g.aborted, first, 'the abort reason is decided once');
  g.recordSuccess();
  assert.equal(g.isAborted, true, 'a later success cannot un-abort a stopped batch');
});
