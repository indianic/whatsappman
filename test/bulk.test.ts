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
