import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolate the config dir before importing anything that resolves paths.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-rename-mgr-'));
process.env.WHATSAPPMAN_DIR = dir;

const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { writeMeta, sessionDir, readMeta } = await import('../src/config/sessions.ts');
const { readState, writeState } = await import('../src/config/state.ts');
const { WhatsAppManError, ErrorCode } = await import('../src/errors.ts');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * renameSession is the riskiest command added: it MOVES a directory holding
 * WhatsApp credentials and repoints the default. A bug here doesn't produce a
 * wrong message — it loses a linked number. These drive the real method.
 *
 * No creds.json is written, so `hasCreds` is false and the reconnect at the end
 * of renameSession is skipped — the whole path is exercised without a socket.
 */
function makeSession(label: string): void {
  writeMeta({
    schemaVersion: 1,
    label,
    phone: '919000000000',
    status: 'disconnected',
    linkedAt: null,
    lastConnectedAt: null,
  });
}

test('rename moves the session directory and rewrites its label', async () => {
  makeSession('work');
  const sm = new SessionManager();
  const r = await sm.renameSession('work', 'office');

  assert.equal(r.from, 'work');
  assert.equal(r.to, 'office');
  assert.equal(fs.existsSync(sessionDir('work')), false, 'the old directory must be gone');
  assert.equal(fs.existsSync(sessionDir('office')), true, 'the new directory must exist');
  assert.equal(readMeta('office')?.label, 'office');
  assert.equal(readMeta('office')?.phone, '919000000000', 'the number must survive the rename');
});

test('rename carries the default pointer over', async () => {
  // Renaming your default number must not silently leave you with no default —
  // the next `send` without --from would fail with NO_DEFAULT_SESSION.
  makeSession('alerts');
  writeState({
    schemaVersion: 1,
    daemonId: 'd',
    pid: 1,
    hostname: 'h',
    startedAt: new Date(0).toISOString(),
    defaultSession: 'alerts',
  });
  const sm = new SessionManager();
  await sm.renameSession('alerts', 'oncall');
  assert.equal(readState()?.defaultSession, 'oncall', 'the default must follow the rename');
});

test('rename refuses a label that is already taken', async () => {
  // Without this guard the move would clobber another number's credentials.
  makeSession('a1');
  makeSession('a2');
  const sm = new SessionManager();
  await assert.rejects(
    () => sm.renameSession('a1', 'a2'),
    (e: unknown) => e instanceof WhatsAppManError && e.code === ErrorCode.BAD_REQUEST,
  );
  assert.equal(fs.existsSync(sessionDir('a1')), true, 'the source must be untouched after a refusal');
  assert.equal(fs.existsSync(sessionDir('a2')), true, 'the target must be untouched after a refusal');
});

test('rename refuses a no-op rename to the same label', async () => {
  makeSession('same');
  const sm = new SessionManager();
  await assert.rejects(
    () => sm.renameSession('same', 'same'),
    (e: unknown) => e instanceof WhatsAppManError && e.code === ErrorCode.BAD_REQUEST,
  );
  assert.equal(fs.existsSync(sessionDir('same')), true, 'a no-op must not delete anything');
});

test('rename refuses an unknown source label', async () => {
  const sm = new SessionManager();
  await assert.rejects(
    () => sm.renameSession('ghost', 'whatever'),
    (e: unknown) => e instanceof WhatsAppManError && e.code === ErrorCode.SESSION_NOT_FOUND,
  );
  assert.equal(fs.existsSync(sessionDir('whatever')), false, 'nothing may be created for a miss');
});
