import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-sched-'));
process.env.WHATSAPPMAN_DIR = dir;

const { computeDelayMs } = await import('../src/daemon/scheduler.ts');
const { readScheduled, addScheduled, updateScheduled, writeScheduled } = await import(
  '../src/config/scheduled.ts'
);
import type { ScheduledEntry } from '../src/config/schema.ts';

test('computeDelayMs: future delay, floored past, capped max', () => {
  assert.equal(computeDelayMs(10_000, 4_000), 6_000);
  assert.equal(computeDelayMs(1_000, 5_000), 0); // past → fire ASAP
  assert.equal(computeDelayMs(Number.MAX_SAFE_INTEGER, 0), 2_147_483_647); // capped
});

function entry(id: string, status: ScheduledEntry['status'] = 'pending'): ScheduledEntry {
  return {
    id,
    from: 'work',
    toJid: '123@s.whatsapp.net',
    toName: 'K',
    kind: 'text',
    text: 'hi',
    fireAt: '2026-07-03T09:00:00.000Z',
    createdAt: '2026-07-02T09:00:00.000Z',
    status,
    messageId: null,
    error: null,
  };
}

test('scheduled store round-trips and survives a re-read (restart)', () => {
  writeScheduled([entry('a'), entry('b', 'sent')]);
  const read = readScheduled();
  assert.equal(read.length, 2);
  assert.equal(read[0].id, 'a');
  assert.equal(read[1].status, 'sent');
});

test('addScheduled appends and updateScheduled patches by id', () => {
  writeScheduled([]);
  addScheduled(entry('c'));
  addScheduled(entry('d'));
  assert.equal(readScheduled().length, 2);

  updateScheduled('c', { status: 'sent', messageId: 'MID' });
  const c = readScheduled().find((e) => e.id === 'c');
  assert.equal(c?.status, 'sent');
  assert.equal(c?.messageId, 'MID');

  // Unknown id is a no-op, not an error.
  updateScheduled('nope', { status: 'failed' });
  assert.equal(readScheduled().length, 2);
});
