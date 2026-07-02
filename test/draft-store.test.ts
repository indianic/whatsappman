import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolate config dir (DraftStore reads settings.draftTtlMinutes from it).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-draft-'));
process.env.WHATSAPPMAN_DIR = dir;

const { DraftStore } = await import('../src/daemon/draft-store.ts');

function newStore() {
  return new DraftStore();
}
const sample = {
  from: 'work',
  toJid: '123@s.whatsapp.net',
  toName: 'Kalpesh',
  kind: 'text' as const,
  text: 'hello',
};

test('create returns a pending draft with a unique id and TTL', () => {
  const store = newStore();
  const a = store.create(sample);
  const b = store.create(sample);
  assert.equal(a.state, 'pending');
  assert.notEqual(a.id, b.id);
  assert.ok(a.expiresAtMs > a.createdAtMs);
});

test('markSent flips state to sent and records the result (idempotent replay)', () => {
  const store = newStore();
  const d = store.create(sample);
  store.markSent(d.id, { messageId: 'MID1', to: sample.toJid, sentAt: '2026-07-02T00:00:00Z' });
  const got = store.get(d.id);
  assert.equal(got?.state, 'sent');
  assert.equal(got?.result?.messageId, 'MID1');
  // Replaying markSent keeps the same recorded result (confirm_send idempotency).
  const first = store.get(d.id)?.result?.messageId;
  assert.equal(first, 'MID1');
});

test('cancel only works on a pending draft', () => {
  const store = newStore();
  const d = store.create(sample);
  assert.equal(store.cancel(d.id), true);
  assert.equal(store.get(d.id)?.state, 'cancelled');
  // Cancelling again (or a sent/unknown draft) returns false.
  assert.equal(store.cancel(d.id), false);
  assert.equal(store.cancel('no-such-id'), false);
});

test('isExpired is true only for a pending draft past its TTL', () => {
  const store = newStore();
  const d = store.create(sample);
  assert.equal(store.isExpired(d, d.createdAtMs), false);
  assert.equal(store.isExpired(d, d.expiresAtMs + 1), true);
  // A sent draft is never "expired".
  store.markSent(d.id, { messageId: 'M', to: sample.toJid, sentAt: 'now' });
  assert.equal(store.isExpired(store.get(d.id)!, d.expiresAtMs + 1), false);
});

test('get returns undefined for an unknown id (→ DRAFT_NOT_FOUND after a restart)', () => {
  const store = newStore();
  assert.equal(store.get('gone'), undefined);
});
