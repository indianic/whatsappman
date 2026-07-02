import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Server } from 'node:net';

// Isolate config dir before importing anything that resolves paths.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-ipc-'));
process.env.WHATSAPPMAN_DIR = dir;

const { ensureBaseDir, socketPath } = await import('../src/config/paths.ts');
const { startIpcServer } = await import('../src/ipc/server.ts');
const { request, ping } = await import('../src/ipc/client.ts');
const { rotateToken, verifyToken, clearToken } = await import('../src/ipc/access.ts');
const { WhatsAppManError, ErrorCode } = await import('../src/errors.ts');

let server: Server | null = null;

before(async () => {
  ensureBaseDir();
});

after(() => {
  if (server) server.close();
  clearToken();
});

test('DAEMON_DOWN when no daemon is running', async () => {
  clearToken(); // no token file → client should short-circuit to DAEMON_DOWN
  assert.equal(await ping(), false);
  await assert.rejects(
    () => request('status'),
    (err: unknown) => err instanceof WhatsAppManError && err.code === ErrorCode.DAEMON_DOWN,
  );
});

test('verifyToken: matches the current token, rejects others', () => {
  const t = rotateToken();
  assert.equal(verifyToken(t), true);
  assert.equal(verifyToken('wrong'), false);
  assert.equal(verifyToken(t + 'x'), false); // different length
});

test('IPC round-trip: ping returns pong through the real server', async () => {
  rotateToken();
  server = await startIpcServer(
    new Map([
      ['ping', () => ({ pong: true, pid: 123 })],
      ['status', () => ({ ok: true })],
    ]) as never,
  );
  const res = await request<{ pong: boolean; pid: number }>('ping');
  assert.equal(res.pong, true);
  assert.equal(res.pid, 123);
});

test('a request with the wrong token is rejected UNAUTHORIZED', async () => {
  // Raw connection so we control the token field directly.
  const line = JSON.stringify({ id: 'x1', token: 'not-the-token', method: 'ping' }) + '\n';
  const response = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(socketPath());
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line));
    sock.on('data', (c: string) => {
      buf += c;
      if (buf.includes('\n')) {
        sock.destroy();
        resolve(buf.trim());
      }
    });
    sock.on('error', reject);
  });
  const parsed = JSON.parse(response);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, ErrorCode.UNAUTHORIZED);
});

test('a malformed request line is rejected BAD_REQUEST', async () => {
  const response = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(socketPath());
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('{ not valid json\n'));
    sock.on('data', (c: string) => {
      buf += c;
      if (buf.includes('\n')) {
        sock.destroy();
        resolve(buf.trim());
      }
    });
    sock.on('error', reject);
  });
  const parsed = JSON.parse(response);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, ErrorCode.BAD_REQUEST);
});
