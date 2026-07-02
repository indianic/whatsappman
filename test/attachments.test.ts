import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-att-'));
process.env.WHATSAPPMAN_DIR = path.join(dir, '.whatsappman');

const { resolveAttachment, MAX_ATTACHMENT_BYTES } = await import('../src/daemon/attachments.ts');
const { WhatsAppManError, ErrorCode } = await import('../src/errors.ts');

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof WhatsAppManError && e.code === code);
}

test('resolves a normal file with mimetype + size', () => {
  const f = path.join(dir, 'hello.txt');
  fs.writeFileSync(f, 'hi there');
  const r = resolveAttachment(f);
  assert.equal(r.filename, 'hello.txt');
  assert.equal(r.sizeBytes, 8);
  assert.equal(r.mimetype, 'text/plain');
  assert.ok(path.isAbsolute(r.absPath));
});

test('missing file → ATTACHMENT_NOT_FOUND', () => {
  expectCode(() => resolveAttachment(path.join(dir, 'nope.pdf')), ErrorCode.ATTACHMENT_NOT_FOUND);
});

test('a directory is not a file → ATTACHMENT_NOT_FOUND', () => {
  expectCode(() => resolveAttachment(dir), ErrorCode.ATTACHMENT_NOT_FOUND);
});

test('sensitive paths are forbidden (exfiltration guard)', () => {
  const ssh = path.join(os.homedir(), '.ssh', 'id_rsa');
  expectCode(() => resolveAttachment(ssh), ErrorCode.ATTACHMENT_FORBIDDEN);

  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'SECRET=1');
  expectCode(() => resolveAttachment(env), ErrorCode.ATTACHMENT_FORBIDDEN);

  const pem = path.join(dir, 'server.pem');
  fs.writeFileSync(pem, 'x');
  expectCode(() => resolveAttachment(pem), ErrorCode.ATTACHMENT_FORBIDDEN);
});

test('files inside the whatsappman config dir are forbidden', () => {
  const cfg = process.env.WHATSAPPMAN_DIR!;
  fs.mkdirSync(cfg, { recursive: true });
  const creds = path.join(cfg, 'daemon.token');
  fs.writeFileSync(creds, 'tok');
  expectCode(() => resolveAttachment(creds), ErrorCode.ATTACHMENT_FORBIDDEN);
});

test('oversized file → ATTACHMENT_TOO_LARGE', () => {
  const big = path.join(dir, 'big.bin');
  // Sparse file just over the cap — no real allocation.
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, MAX_ATTACHMENT_BYTES + 1);
  fs.closeSync(fd);
  expectCode(() => resolveAttachment(big), ErrorCode.ATTACHMENT_TOO_LARGE);
});
