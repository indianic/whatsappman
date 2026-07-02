import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isNewerVersion } = await import('../src/cli/update-notifier.ts');

test('isNewerVersion: strictly-newer comparisons', () => {
  assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true); // numeric, not lexical
});

test('isNewerVersion: equal or older is not newer', () => {
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), false); // dev ahead of registry
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
});

test('isNewerVersion: tolerates a leading v and a -tag', () => {
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0-beta', '0.1.0'), false); // prerelease not newer than release
  assert.equal(isNewerVersion('0.2.0-rc1', '0.1.0'), true);
});
