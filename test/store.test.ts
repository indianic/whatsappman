import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Isolate config dir before importing anything that resolves paths.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-store-'));
process.env.WHATSAPPMAN_DIR = dir;

const { readJson, writeJson } = await import('../src/config/store.ts');
const { stateSchema } = await import('../src/config/schema.ts');

const schema = z.object({ schemaVersion: z.literal(1), value: z.string() });

test('writeJson then readJson round-trips', () => {
  const file = path.join(dir, 'a.json');
  writeJson(file, { schemaVersion: 1, value: 'hello' });
  const read = readJson(file, schema);
  assert.deepEqual(read, { schemaVersion: 1, value: 'hello' });
});

test('writeJson keeps a .bak of the previous good version', () => {
  const file = path.join(dir, 'b.json');
  writeJson(file, { schemaVersion: 1, value: 'first' });
  writeJson(file, { schemaVersion: 1, value: 'second' });
  const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(bak.value, 'first');
});

test('readJson recovers from .bak when the primary file is corrupt', () => {
  const file = path.join(dir, 'c.json');
  writeJson(file, { schemaVersion: 1, value: 'good' });
  writeJson(file, { schemaVersion: 1, value: 'good2' }); // creates .bak = good... wait, .bak = good
  // Corrupt the primary file.
  fs.writeFileSync(file, '{ this is not json');
  const read = readJson(file, schema);
  // .bak holds the previous good write ("good"), so recovery returns that.
  assert.ok(read !== null);
  assert.equal(read?.value, 'good');
});

test('writeJson writes the file with 0600 perms', () => {
  if (process.platform === 'win32') return;
  const file = path.join(dir, 'd.json');
  writeJson(file, { schemaVersion: 1, value: 'x' });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('readJson returns null for a missing file', () => {
  assert.equal(readJson(path.join(dir, 'nope.json'), stateSchema), null);
});
