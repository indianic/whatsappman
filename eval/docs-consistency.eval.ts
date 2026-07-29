import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
