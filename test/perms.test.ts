import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A real daemon start, to assert the on-disk artifacts get restrictive perms.
// POSIX-only (Windows uses a named pipe + DACL, not filesystem perms).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-perms-'));
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

let child: ReturnType<typeof spawn> | null = null;

after(() => {
  if (child) child.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a freshly started daemon writes 0700 dir + 0600 socket/token/pid', { skip: process.platform === 'win32' }, async () => {
  if (!fs.existsSync(entry)) {
    // dist not built — skip rather than fail spuriously.
    return;
  }
  child = spawn(process.execPath, [entry, 'daemon', 'start'], {
    env: { ...process.env, WHATSAPPMAN_DIR: dir },
    stdio: 'ignore',
  });

  // Wait for the daemon to come up (socket + token appear).
  const sock = path.join(dir, 'daemon.sock');
  const token = path.join(dir, 'daemon.token');
  for (let i = 0; i < 40 && !(fs.existsSync(sock) && fs.existsSync(token)); i++) {
    await sleep(100);
  }

  assert.equal(mode(dir), 0o700, 'config dir is 0700');
  assert.ok(fs.existsSync(sock), 'socket exists');
  assert.equal(mode(sock), 0o600, 'socket is 0600');
  assert.equal(mode(token), 0o600, 'token is 0600');
  assert.equal(mode(path.join(dir, 'daemon.pid')), 0o600, 'pidfile is 0600');
  assert.equal(mode(path.join(dir, 'sessions')), 0o700, 'sessions dir is 0700');
});
