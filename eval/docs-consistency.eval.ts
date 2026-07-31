import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/mcp/server.js';

/**
 * Docs make specific, countable claims about the tool surface ("12 MCP tools",
 * "no raw send tool"). Those are the first thing a user reads and the last
 * thing anyone updates. These evals fail the moment a claim stops being true,
 * so the README can't quietly start lying after a tool is added or removed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const TOOL_COUNT = Object.keys(TOOLS).length;

test('the README badge states the real tool count', () => {
  const readme = read('README.md');
  const badge = readme.match(/MCP-(\d+)%20tools/);
  assert.ok(badge, 'README is missing the MCP tools badge');
  assert.equal(
    Number(badge[1]),
    TOOL_COUNT,
    `badge says ${badge[1]} tools, the server registers ${TOOL_COUNT}`,
  );
});

test('the README prose states the real tool count', () => {
  const readme = read('README.md');
  const line = readme.match(/^- (\d+) MCP tools, exposed to your AI over MCP$/m);
  assert.ok(line, 'README feature bullet for the tool count is missing or reworded');
  assert.equal(Number(line[1]), TOOL_COUNT);
});

test('docs/FEATURES.md states the real tool count', () => {
  const features = read('docs/FEATURES.md');
  const counts = [...features.matchAll(/(\d+) tools/g)].map((m) => Number(m[1]));
  assert.ok(counts.length > 0, 'FEATURES.md no longer states a tool count');
  for (const c of counts) {
    assert.equal(c, TOOL_COUNT, `FEATURES.md claims ${c} tools, the server registers ${TOOL_COUNT}`);
  }
});

test('the "no raw send tool" promise is stated in the docs and true in code', () => {
  // Both halves matter: the claim must be present for users, and correct in code.
  const readme = read('README.md');
  const features = read('docs/FEATURES.md');
  assert.match(readme, /no raw "send"/i, 'README dropped the no-raw-send promise');
  assert.match(features, /no raw "send" tool/i, 'FEATURES.md dropped the no-raw-send promise');

  const rawSenders = Object.entries(TOOLS).filter(([, d]) => ['send_text', 'send_bulk'].includes(d.method));
  assert.deepEqual(rawSenders.map(([n]) => n), [], 'the docs promise no raw send, but one is exposed');
});

test('every documented tool name exists, and every tool is documented', () => {
  const features = read('docs/FEATURES.md');
  const undocumented = Object.keys(TOOLS).filter((name) => !features.includes(name));
  assert.deepEqual(undocumented, [], `tools missing from docs/FEATURES.md: ${undocumented.join(', ')}`);
});

test('the package name in the docs matches what is published', () => {
  const pkg = JSON.parse(read('package.json')) as { name: string };
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.name), `README never mentions the published name ${pkg.name}`);
  // The retired private scope must not creep back into user-facing install docs.
  assert.doesNotMatch(readme, /@indianic\/whatsappman/, 'README references the retired private package');
  assert.doesNotMatch(readme, /npm\.indianic\.in/, 'README references the retired private registry');
});

/* ── version drift ─────────────────────────────────────────────────────────
 * docs/FEATURES.md shipped its header as "Version: 0.3.0" while the package was
 * at 0.4.2, publicly, on GitHub. This is the SECOND time: the strings were
 * fixed by hand once and the invariant was never pinned, so it came straight
 * back. That is the whole argument for an eval over a fix.
 *
 * The distinction that makes this checkable without false positives is between
 * a doc *declaring what it is* and a doc *describing history*:
 *
 *   "**Version:** 0.3.0"                 <- a self-declaration. Must be current.
 *   "@integratex/whatsappman@0.3.0"      <- a pinned install. Must be current.
 *   "## Modules added since 0.3.0"       <- history. Correct forever.
 *   "Verified live against the published 0.1.0"  <- history. Correct forever.
 *
 * So only the first two shapes are enforced. Prose about past releases stays
 * legal, which is what keeps this eval alive rather than switched off.
 */

const PKG_VERSION = JSON.parse(read('package.json')).version as string;

function docsWithVersionClaims(dir = '.'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', 'shots'].includes(e.name)) continue;
    // Dot-directories are tooling and local state, never published docs.
    // `.remember/` in particular is a gitignored work journal whose entries are
    // dated notes about what was true that day — "Published 0.2.1" is correct
    // forever, exactly like a CHANGELOG line, and rewriting it would be
    // falsifying a record rather than fixing a doc.
    if (e.name.startsWith('.')) continue;
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...docsWithVersionClaims(rel));
    // CHANGELOG is a historical record by definition.
    else if (e.name.endsWith('.md') && e.name !== 'CHANGELOG.md') out.push(rel);
  }
  return out;
}

const VERSION_DOCS = docsWithVersionClaims();

test('the version sweep reached the docs that declare one', () => {
  assert.ok(VERSION_DOCS.includes('docs/FEATURES.md'), 'the sweep missed docs/FEATURES.md');
  assert.ok(VERSION_DOCS.length >= 5, `only swept ${VERSION_DOCS.length} docs`);
});

test('no doc declares itself at a version the package is not at', () => {
  const stale: string[] = [];
  for (const f of VERSION_DOCS) {
    for (const m of read(f).matchAll(/\*{0,2}Version:?\*{0,2}:?\s*`?v?(\d+\.\d+\.\d+)`?/gi)) {
      if (m[1] !== PKG_VERSION) stale.push(`${f}: declares ${m[1]}, package is ${PKG_VERSION}`);
    }
  }
  assert.deepEqual(stale, [], `stale version declaration — ${stale.join('; ')}`);
});

test('no doc pins an install to a version that is not current', () => {
  // `npm i -g @integratex/whatsappman@0.3.0` in a doc installs a build from
  // months ago. Unversioned (or @latest) is what a reader should be given.
  const pkgName = JSON.parse(read('package.json')).name as string;
  const pinned: string[] = [];
  for (const f of VERSION_DOCS) {
    const re = new RegExp(`${pkgName.replace(/[/@]/g, '\\$&')}@(\\d+\\.\\d+\\.\\d+)`, 'g');
    for (const m of read(f).matchAll(re)) {
      if (m[1] !== PKG_VERSION) pinned.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(pinned, [], `doc pins a stale install version: ${pinned.join(', ')}`);
});

test('the README version badge stays dynamic', () => {
  // The badge reads the live version from the registry. Replacing it with a
  // hardcoded number reintroduces exactly the drift the tests above prevent,
  // in the most-read file in the repo.
  const readme = read('README.md');
  assert.match(readme, /img\.shields\.io\/npm\/v\//, 'the npm version badge must be the dynamic shields.io one');
  const hardcoded = [...readme.matchAll(/badge\/version-(\d+\.\d+\.\d+)/g)].map((m) => m[0]);
  assert.deepEqual(hardcoded, [], `README hardcodes a version badge: ${hardcoded.join(', ')}`);
});
