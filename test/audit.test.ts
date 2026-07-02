import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-audit-'));
process.env.WHATSAPPMAN_DIR = dir;

const { appendSent, readRecent } = await import('../src/audit.ts');
const { sentLogPath } = await import('../src/config/paths.ts');

function entry(i: number, from = 'work', status: 'sent' | 'failed' = 'sent') {
  return {
    ts: `2026-07-02T00:00:${String(i).padStart(2, '0')}.000Z`,
    from,
    toJid: `${i}@s.whatsapp.net`,
    toName: `n${i}`,
    kind: 'text',
    messageId: `M${i}`,
    status,
  };
}

test('readRecent returns newest-first and respects limit', () => {
  fs.rmSync(sentLogPath(), { force: true });
  for (let i = 1; i <= 5; i++) appendSent(entry(i));
  const recent = readRecent(3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].messageId, 'M5'); // newest first
  assert.equal(recent[2].messageId, 'M3');
});

test('readRecent filters by session (from)', () => {
  fs.rmSync(sentLogPath(), { force: true });
  appendSent(entry(1, 'work'));
  appendSent(entry(2, 'personal'));
  appendSent(entry(3, 'work'));
  const work = readRecent(20, 'work');
  assert.equal(work.length, 2);
  assert.ok(work.every((e) => e.from === 'work'));
});

test('readRecent skips corrupt lines without throwing', () => {
  fs.rmSync(sentLogPath(), { force: true });
  appendSent(entry(1));
  fs.appendFileSync(sentLogPath(), 'this is not json\n');
  appendSent(entry(2));
  const recent = readRecent(20);
  assert.equal(recent.length, 2);
});

test('appendSent rotates the log to .1 once it exceeds the cap', () => {
  fs.rmSync(sentLogPath(), { force: true });
  fs.rmSync(`${sentLogPath()}.1`, { force: true });
  // Write a >5MB file, then one more append triggers rotation.
  fs.writeFileSync(sentLogPath(), 'x'.repeat(5 * 1024 * 1024 + 10));
  appendSent(entry(99));
  assert.ok(fs.existsSync(`${sentLogPath()}.1`), 'previous generation kept as .1');
  // The fresh log holds only the new entry.
  const recent = readRecent(20);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].messageId, 'M99');
});

test('readRecent returns [] when no log exists', () => {
  fs.rmSync(sentLogPath(), { force: true });
  assert.deepEqual(readRecent(), []);
});
