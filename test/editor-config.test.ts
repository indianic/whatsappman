import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  EDITORS,
  SERVER_KEY,
  jsonServerBlock,
  mergeJsonMcpServers,
  mergeCodexToml,
  writeEditorConfig,
  resolveTools,
} from '../src/cli/editor-config.js';
import { getPackageName } from '../src/version.js';

// Derived, not hardcoded — the launch block must track whatever name
// package.json publishes under, so a re-scope can't silently leave editor
// configs pointing at a package that no longer resolves.
const PKG = getPackageName();

test('jsonServerBlock is the secretless npx launch of the scoped package (no env)', () => {
  const block = jsonServerBlock();
  assert.deepEqual(block, { command: 'npx', args: ['-y', PKG] });
  assert.ok(!('env' in block), 'must carry no env — creds live under ~/.whatsappman, not editor config');
});

test('mergeJsonMcpServers adds the whatsappman entry and leaves other servers/keys untouched', () => {
  const existing = {
    someTopLevelKey: 42,
    mcpServers: { other: { command: 'foo', args: ['bar'] } },
  };
  const merged = mergeJsonMcpServers(existing);
  const servers = merged.mcpServers as Record<string, unknown>;
  assert.deepEqual(servers.other, { command: 'foo', args: ['bar'] }, 'unrelated server preserved');
  assert.deepEqual(servers[SERVER_KEY], { command: 'npx', args: ['-y', PKG] });
  assert.equal(merged.someTopLevelKey, 42, 'unrelated top-level key preserved');
});

test('mergeJsonMcpServers creates mcpServers when the file had none', () => {
  const merged = mergeJsonMcpServers({});
  assert.ok(merged.mcpServers && typeof merged.mcpServers === 'object');
  assert.ok((merged.mcpServers as Record<string, unknown>)[SERVER_KEY]);
});

test('mergeJsonMcpServers is idempotent — re-running yields one entry, not duplicated/nested', () => {
  const once = mergeJsonMcpServers({});
  const twice = mergeJsonMcpServers(once);
  assert.deepEqual(twice, once);
});

test('mergeCodexToml appends a whatsappman block and replaces (not duplicates) on re-run', () => {
  const first = mergeCodexToml('');
  assert.match(first, /\[mcp_servers\.whatsappman\]/);
  assert.ok(first.includes(PKG), `codex block must launch ${PKG}`);

  const second = mergeCodexToml(first);
  const occurrences = second.split('[mcp_servers.whatsappman]').length - 1;
  assert.equal(occurrences, 1, 're-running must replace the block, not add a second');
});

test('mergeCodexToml preserves an unrelated [mcp_servers.*] block', () => {
  const existing = '[mcp_servers.other]\ncommand = "foo"\nargs = ["bar"]\n';
  const merged = mergeCodexToml(existing);
  assert.match(merged, /\[mcp_servers\.other\]/, 'unrelated server preserved');
  assert.match(merged, /\[mcp_servers\.whatsappman\]/, 'whatsappman added');
});

test('resolveTools: "all"/undefined → every editor; a CSV filters to known ids only', () => {
  assert.deepEqual(resolveTools('all'), EDITORS.map((e) => e.id));
  assert.deepEqual(resolveTools(undefined), EDITORS.map((e) => e.id));
  assert.deepEqual(resolveTools('claude, cursor , bogus'), ['claude', 'cursor']);
});

function withTempHome(fn: (home: string, cwd: string) => void): void {
  const base = path.join(os.tmpdir(), `whatsappman-editcfg-${crypto.randomBytes(6).toString('hex')}`);
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try {
    fn(home, cwd);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('writeEditorConfig (Claude, global) creates ~/.claude.json with the merged block', () => {
  withTempHome((home, cwd) => {
    const claude = EDITORS.find((e) => e.id === 'claude')!;
    const result = writeEditorConfig(claude, 'global', cwd, home);
    assert.equal(result.action, 'created');
    assert.equal(result.file, path.join(home, '.claude.json'));
    const parsed = JSON.parse(readFileSync(result.file, 'utf8'));
    assert.deepEqual(parsed.mcpServers.whatsappman, { command: 'npx', args: ['-y', PKG] });
  });
});

test('writeEditorConfig (Claude, project) writes .mcp.json in cwd and reports "updated" on re-run', () => {
  withTempHome((home, cwd) => {
    const claude = EDITORS.find((e) => e.id === 'claude')!;
    const first = writeEditorConfig(claude, 'project', cwd, home);
    assert.equal(first.action, 'created');
    assert.equal(first.file, path.join(cwd, '.mcp.json'));
    const second = writeEditorConfig(claude, 'project', cwd, home);
    assert.equal(second.action, 'updated');
  });
});

test('writeEditorConfig honors userLevelOnly (Gemini ignores project scope, writes under home)', () => {
  withTempHome((home, cwd) => {
    const gemini = EDITORS.find((e) => e.id === 'gemini')!;
    const result = writeEditorConfig(gemini, 'project', cwd, home);
    assert.ok(result.file.startsWith(home), 'user-level editor must write under home even for project scope');
    assert.ok(!result.file.startsWith(cwd));
  });
});

test('writeEditorConfig preserves a pre-existing unrelated server in the file', () => {
  withTempHome((home, cwd) => {
    const file = path.join(home, '.claude.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'x', args: [] } } }));
    const claude = EDITORS.find((e) => e.id === 'claude')!;
    writeEditorConfig(claude, 'global', cwd, home);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(parsed.mcpServers.keep, 'unrelated server survived the merge');
    assert.ok(parsed.mcpServers.whatsappman, 'whatsappman added');
  });
});

test('writeEditorConfig (Codex) writes valid TOML at ~/.codex/config.toml', () => {
  withTempHome((home, cwd) => {
    const codex = EDITORS.find((e) => e.id === 'codex')!;
    const result = writeEditorConfig(codex, 'global', cwd, home);
    assert.equal(result.file, path.join(home, '.codex', 'config.toml'));
    assert.ok(existsSync(result.file));
    assert.match(readFileSync(result.file, 'utf8'), /\[mcp_servers\.whatsappman\]/);
  });
});
