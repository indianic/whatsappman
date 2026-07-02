import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated, empty config dir — no sessions exist.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-guard-'));
process.env.WHATSAPPMAN_DIR = dir;

const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { WhatsAppManError, ErrorCode } = await import('../src/errors.ts');

const isNotFound = (e: unknown) =>
  e instanceof WhatsAppManError && e.code === ErrorCode.SESSION_NOT_FOUND;

// Regression: `reconnect`/`relink` on an unknown label used to silently spin up
// a brand-new Baileys session (QR + socket) instead of erroring. They must now
// reject SESSION_NOT_FOUND, and must NOT create any session.
test('session-mgmt on an unknown label errors and creates nothing', async () => {
  const sm = new SessionManager();
  assert.equal(sm.isKnownSession('ghost'), false);

  await assert.rejects(() => sm.reconnect('ghost'), isNotFound);
  await assert.rejects(() => sm.relink('ghost'), isNotFound);
  assert.throws(() => sm.disconnect('ghost'), isNotFound);
  assert.throws(() => sm.deleteSession('ghost'), isNotFound);

  // No session folder or in-memory session was conjured.
  assert.equal(sm.isKnownSession('ghost'), false);
  assert.equal(sm.listSummaries().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'ghost')), false);
});
