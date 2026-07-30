import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hygiene rubrics: the things that are fine on the machine that wrote them and
 * break for everyone else. Each of these is here because it actually happened.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const filesIn = (dir: string) =>
  existsSync(path.join(ROOT, dir))
    ? readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts') || f.endsWith('.mjs'))
    : [];

/** Helpers that resolve a path inside the user's REAL ~/.whatsappman. */
const CONFIG_TOUCHING = ['baseDir(', 'qrImagePath(', 'sessionDir(', 'authDir(', 'metaPath(', 'socketPath(', 'tokenPath(', 'writeMeta(', 'ensureBaseDir('];

test('no test writes into the real config dir', () => {
  // This is here because a test wrote ~/.whatsappman/qr-evaltest.png and passed
  // for months on a machine that had the directory — then failed on the first
  // CI run, on a fresh box where it did not exist. It was also quietly
  // polluting the developer's own config dir on every run. A test that touches
  // config paths must sandbox first via WHATSAPPMAN_DIR.
  const offenders: string[] = [];
  for (const dir of ['test', 'smoke']) {
    for (const f of filesIn(dir)) {
      const src = read(path.join(dir, f));
      const touches = CONFIG_TOUCHING.some((h) => src.includes(h));
      if (touches && !src.includes('WHATSAPPMAN_DIR')) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these touch real config paths without sandboxing WHATSAPPMAN_DIR: ${offenders.join(', ')}`,
  );
});

test('every test that sandboxes also restores the env afterwards', () => {
  // A test that sets WHATSAPPMAN_DIR and never restores it leaks into whatever
  // test file the runner executes next in the same worker — which shows up as
  // an unrelated test failing, the worst kind of failure to chase.
  const leaky: string[] = [];
  for (const dir of ['test', 'smoke']) {
    for (const f of filesIn(dir)) {
      const src = read(path.join(dir, f));
      if (!src.includes("process.env.WHATSAPPMAN_DIR =")) continue;
      const restores =
        src.includes('delete process.env.WHATSAPPMAN_DIR') || /saved|prev|original/i.test(src);
      // A file that sets it once at import time to isolate the WHOLE file is a
      // deliberate, documented pattern (see test/ipc.test.ts) — it never
      // restores because the file owns its process.
      const wholeFileIsolation = /^const dir = fs\.mkdtempSync/m.test(src) || src.includes('// Isolate');
      if (!restores && !wholeFileIsolation) leaky.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(leaky, [], `set WHATSAPPMAN_DIR without restoring it: ${leaky.join(', ')}`);
});

test('the published package ships only the runtime, never the workshop', () => {
  // Verified by hand three times during one release; it should be automatic.
  const pkg = JSON.parse(read('package.json')) as { files?: string[]; bin?: Record<string, string> };
  assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'package.json needs an explicit "files" allowlist');
  const forbidden = ['test', 'eval', 'smoke', 'docs', 'scripts', 'site', '.github', 'CHANGELOG.md', 'CONTEXT.md'];
  const leaked = pkg.files!.filter((f) => forbidden.some((x) => f === x || f.startsWith(`${x}/`)));
  assert.deepEqual(leaked, [], `these must not be published: ${leaked.join(', ')}`);
});

test('every declared bin target exists on disk', () => {
  // A bin pointing at a file that does not exist installs cleanly and then
  // fails the first time anyone runs the command.
  const pkg = JSON.parse(read('package.json')) as { bin?: Record<string, string> };
  const missing = Object.entries(pkg.bin ?? {})
    .filter(([, target]) => !existsSync(path.join(ROOT, target)))
    .map(([name, target]) => `${name} -> ${target}`);
  assert.deepEqual(missing, [], `bin entries with no file: ${missing.join(', ')}`);
});

test('no credential is committed anywhere in the tracked tree', () => {
  // Real PATs pass through this repo's release flow; scripts/ is excluded from
  // the public mirror but is still tracked in git, and a secret in git history
  // is a permanent leak.
  const patterns: Array<[string, RegExp]> = [
    ['GitHub classic PAT', /\bghp_[A-Za-z0-9]{30,}/],
    ['GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{30,}/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ];
  const hits: string[] = [];
  const scan = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'site'].includes(e.name)) continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) scan(rel);
      else if (/\.(ts|js|mjs|json|md|sh|ya?ml)$/.test(e.name)) {
        const src = readFileSync(path.join(ROOT, rel), 'utf8');
        for (const [label, re] of patterns) if (re.test(src)) hits.push(`${rel}: ${label}`);
      }
    }
  };
  scan('.');
  assert.deepEqual(hits, [], `credentials found in tracked files: ${hits.join(' | ')}`);
});
