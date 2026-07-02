import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-sessions-'));
process.env.WHATSAPPMAN_DIR = dir;

const { normalizeLabel, listSessionLabels } = await import('../src/config/sessions.ts');
const { WhatsAppManError } = await import('../src/errors.ts');

test('normalizeLabel lowercases + trims valid labels', () => {
  assert.equal(normalizeLabel('default'), 'default');
  assert.equal(normalizeLabel('  Work  '), 'work');
  assert.equal(normalizeLabel('WORK'), 'work');
  assert.equal(normalizeLabel('team-2_a'), 'team-2_a');
  assert.equal(normalizeLabel('9net'), '9net'); // may start with a digit
  assert.equal(normalizeLabel('a'.repeat(32)), 'a'.repeat(32)); // 32 chars = max
});

test('normalizeLabel rejects invalid labels with a BAD_REQUEST WhatsAppManError', () => {
  for (const bad of ['', '  ', '-lead', '_lead', 'has space', 'punct!', 'a'.repeat(33), 'sl/ash', '..']) {
    assert.throws(
      () => normalizeLabel(bad),
      (e: unknown) => e instanceof WhatsAppManError && e.code === 'BAD_REQUEST',
      `expected "${bad}" to be rejected`,
    );
  }
});

test('listSessionLabels returns only valid label directories, sorted, ignoring files + bad names', () => {
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(sessions, 'work'), { recursive: true });
  fs.mkdirSync(path.join(sessions, 'default'), { recursive: true });
  fs.mkdirSync(path.join(sessions, '9net'), { recursive: true });
  fs.mkdirSync(path.join(sessions, 'Bad Name'), { recursive: true }); // space + caps → filtered
  fs.mkdirSync(path.join(sessions, '-nope'), { recursive: true }); // leading dash → filtered
  fs.writeFileSync(path.join(sessions, 'stray.txt'), 'x'); // a file, not a dir → ignored

  assert.deepEqual(listSessionLabels(), ['9net', 'default', 'work']);
});

test('listSessionLabels returns [] when the sessions dir does not exist', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-empty-'));
  process.env.WHATSAPPMAN_DIR = empty;
  try {
    assert.deepEqual(listSessionLabels(), []);
  } finally {
    process.env.WHATSAPPMAN_DIR = dir; // restore for any later tests
  }
});
