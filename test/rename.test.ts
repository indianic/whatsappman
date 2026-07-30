import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, paramsSchemas } from '../src/ipc/protocol.ts';

test('rename_session is an allowlisted method with a params schema', () => {
  assert.ok(METHODS.includes('rename_session'), 'rename_session missing from METHODS');
  assert.ok(paramsSchemas.rename_session, 'rename_session has no params schema');
});

test('rename_session params require both labels', () => {
  const s = paramsSchemas.rename_session;
  assert.ok(s.safeParse({ oldLabel: 'work', newLabel: 'office' }).success);
  assert.ok(!s.safeParse({ oldLabel: 'work' }).success, 'newLabel required');
  assert.ok(!s.safeParse({ newLabel: 'office' }).success, 'oldLabel required');
  assert.ok(!s.safeParse({ oldLabel: '', newLabel: 'office' }).success, 'empty oldLabel rejected');
});

test('renameSessionDir moves the folder and rewrites meta.label; sessionExists tracks it', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-rename-'));
  const saved = process.env.WHATSAPPMAN_DIR;
  process.env.WHATSAPPMAN_DIR = sandbox;
  try {
    const { writeMeta, readMeta, sessionExists, renameSessionDir, sessionDir } = await import('../src/config/sessions.ts');

    writeMeta({ schemaVersion: 1, label: 'work', phone: '+910000000000', status: 'connected', linkedAt: null, lastConnectedAt: null });
    // drop an auth file so we prove creds travel with the rename
    fs.mkdirSync(path.join(sessionDir('work'), 'auth'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir('work'), 'auth', 'creds.json'), '{}');

    assert.equal(sessionExists('work'), true);
    assert.equal(sessionExists('office'), false);

    renameSessionDir('work', 'office');

    assert.equal(sessionExists('work'), false, 'old label must be gone');
    assert.equal(sessionExists('office'), true, 'new label must exist');
    assert.equal(readMeta('office')?.label, 'office', 'meta.label must be rewritten');
    assert.ok(
      fs.existsSync(path.join(sessionDir('office'), 'auth', 'creds.json')),
      'creds must travel with the rename',
    );
  } finally {
    if (saved === undefined) delete process.env.WHATSAPPMAN_DIR;
    else process.env.WHATSAPPMAN_DIR = saved;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
