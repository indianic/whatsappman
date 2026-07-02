import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolResponse, toolError } from '../src/response.ts';
import { WhatsAppManError, ErrorCode } from '../src/errors.ts';

test('toolResponse wraps a value as a single JSON text block, not an error', () => {
  const r = toolResponse({ ok: true, n: 1 });
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, n: 1 });
  assert.ok(!('isError' in r) || r.isError === undefined, 'success is not flagged isError');
});

test('toolError sets isError and a { code, message } payload', () => {
  const r = toolError('BAD_REQUEST', 'nope');
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(r.content[0].text), { code: 'BAD_REQUEST', message: 'nope' });
});

test('toolError includes next_steps only when non-empty', () => {
  const withSteps = JSON.parse(toolError('X', 'm', ['do a', 'do b']).content[0].text);
  assert.deepEqual(withSteps.next_steps, ['do a', 'do b']);

  const emptySteps = JSON.parse(toolError('X', 'm', []).content[0].text);
  assert.ok(!('next_steps' in emptySteps), 'empty next_steps is omitted, not an empty array');
});

test('WhatsAppManError carries a stable code + optional next_steps and is an Error', () => {
  const e = new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, 'gone', ['retry']);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'WhatsAppManError');
  assert.equal(e.code, 'DRAFT_NOT_FOUND');
  assert.equal(e.message, 'gone');
  assert.deepEqual(e.nextSteps, ['retry']);
});
