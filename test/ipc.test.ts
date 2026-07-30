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
const { rotateToken, verifyToken, clearToken, readToken } = await import('../src/ipc/access.ts');
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

test('a method this build has never heard of names the version skew, not "malformed"', async () => {
  // The real-world trigger: a daemon that has been up for a day meets a CLI
  // that just gained a new method. `method` is a z.enum, so the request fails
  // schema validation before the handler lookup that would have said
  // UNKNOWN_METHOD — which used to surface as a bare "malformed request" and
  // sent you hunting for a bug in your arguments instead of restarting.
  const line = JSON.stringify({ id: 'x2', token: readToken(), method: 'some_future_method' }) + '\n';
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
  assert.equal(parsed.error.code, ErrorCode.UNKNOWN_METHOD, 'must not be a generic BAD_REQUEST');
  assert.match(parsed.error.message, /older build/, 'must name the cause');
  assert.deepEqual(parsed.error.next_steps, ['run: whatsappman restart'], 'must say how to fix it');
});
