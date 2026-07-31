import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * docs/USE-CASES.md promises that "every command and flag here was checked
 * against the actual CLI parser — nothing is aspirational syntax." That promise
 * rots the instant someone renames a flag or adds a case citing one that never
 * shipped. This eval makes the promise machine-checked: it derives the real set
 * of commands and flags from src/cli, extracts every `whatsappman …` invocation
 * from the doc's fenced code blocks, and fails on the first token the parser
 * would not recognise. The doc can no longer drift away from the CLI in silence.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// --- source of truth: the CLI itself ---------------------------------------

// Top-level commands, lifted from the COMMANDS array in the CLI entry point.
const commandsBlock = read('src/cli/index.ts').match(/const COMMANDS = \[([\s\S]*?)\];/);
assert.ok(commandsBlock, 'could not find the COMMANDS array in src/cli/index.ts');
const VALID_COMMANDS = new Set([...commandsBlock[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));

// Every `--flag` literal recognised anywhere under src/cli is a valid flag.
const cliDir = path.join(ROOT, 'src/cli');
const cliSrc = readdirSync(cliDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(path.join(cliDir, f), 'utf8'))
  .join('\n');
const VALID_FLAGS = new Set([...cliSrc.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));

// --- what the doc actually cites -------------------------------------------

const doc = read('docs/USE-CASES.md');
// Only look inside fenced code blocks — prose can say "--foo" illustratively.
const codeBlocks = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);

// Flags belonging to a command substituted *inside* a whatsappman message —
// `$(git rev-parse --short HEAD)`, `` `hostname` `` — are not whatsappman flags.
const stripSubshells = (s: string) => s.replace(/\$\([^)]*\)/g, '').replace(/`[^`]*`/g, '');

// Split the code on each `whatsappman` token so every segment is exactly one
// invocation's arguments (up to the next whatsappman), then confine it to the
// invocation itself: its own line, and before any shell operator that would
// start a different command (`&&`, `||`, `|`, `;`).
const citedCommands = new Set<string>();
const citedFlags = new Set<string>();
const segments = stripSubshells(codeBlocks.join('\n')).split(/\bwhatsappman\s+/).slice(1);
for (let seg of segments) {
  const cmd = seg.match(/^([a-z][a-z-]*)/);
  if (cmd) citedCommands.add(cmd[1]);
  seg = seg.split('\n')[0].split(/\s(?:&&|\|\||\||;)\s/)[0];
  for (const f of seg.matchAll(/(--[a-z][a-z-]*)/g)) citedFlags.add(f[1]);
}

// --- the guards ------------------------------------------------------------

test('the CLI source parsed into a non-empty command + flag surface', () => {
  assert.ok(VALID_COMMANDS.size >= 10, `only parsed ${VALID_COMMANDS.size} commands from index.ts`);
  assert.ok(VALID_FLAGS.size >= 10, `only parsed ${VALID_FLAGS.size} flags from src/cli`);
});

test('USE-CASES.md actually contains checkable whatsappman invocations', () => {
  // Guards against a regex change silently making the checks below vacuous.
  assert.ok(citedCommands.size > 0, 'no whatsappman commands found in the doc code blocks');
  assert.ok(citedFlags.size > 0, 'no --flags found in the doc code blocks');
});

test('every command in USE-CASES.md exists in the CLI', () => {
  const unknown = [...citedCommands].filter((c) => !VALID_COMMANDS.has(c));
  assert.deepEqual(
    unknown,
    [],
    `USE-CASES.md uses whatsappman command(s) the CLI does not define: ${unknown.join(', ')}`,
  );
});

test('every flag in USE-CASES.md exists in the CLI', () => {
  const unknown = [...citedFlags].filter((f) => !VALID_FLAGS.has(f));
  assert.deepEqual(
    unknown,
    [],
    `USE-CASES.md uses flag(s) the CLI parser does not recognise: ${unknown.join(', ')}`,
  );
});

/* ── every other doc, held to the same standard ────────────────────────────
 * The checks above cover USE-CASES.md because that file makes the promise
 * explicitly. But README.md is what someone reads *first* and copy-pastes from,
 * and docs/CLI.md is where they look when a command does not behave. A renamed
 * flag rots there exactly as easily and with more people watching.
 *
 * The parser is already written; only its input set changes. CHANGELOG is
 * excluded because it is a historical record — an entry describing a flag that
 * was later removed is correct, not stale.
 */

/** Every tracked markdown file, ignoring build output and dependencies. */
function markdownFiles(dir = '.'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage', 'shots'].includes(e.name)) continue;
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...markdownFiles(rel));
    else if (e.name.endsWith('.md') && e.name !== 'CHANGELOG.md') out.push(rel);
  }
  return out;
}

/** Commands and flags cited inside fenced code blocks of one markdown file. */
function citationsIn(src: string): { commands: Set<string>; flags: Set<string> } {
  const blocks = [...src.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const commands = new Set<string>();
  const flags = new Set<string>();
  for (let seg of stripSubshells(blocks.join('\n')).split(/\bwhatsappman\s+/).slice(1)) {
    const cmd = seg.match(/^([a-z][a-z-]*)/);
    if (cmd) commands.add(cmd[1]);
    seg = seg.split('\n')[0].split(/\s(?:&&|\|\||\||;)\s/)[0];
    for (const f of seg.matchAll(/(--[a-z][a-z-]*)/g)) flags.add(f[1]);
  }
  return { commands, flags };
}

const DOCS = markdownFiles();

test('the docs sweep found the files a reader actually starts from', () => {
  // Vacuity guard: if the walk breaks, the two tests below check nothing.
  assert.ok(DOCS.includes('README.md'), 'README.md not reached by the docs walk');
  assert.ok(DOCS.length >= 5, `only found ${DOCS.length} markdown files`);
});

test('every whatsappman command cited in any doc exists in the CLI', () => {
  const bad: string[] = [];
  for (const f of DOCS) {
    for (const c of citationsIn(read(f)).commands) {
      if (!VALID_COMMANDS.has(c)) bad.push(`${f}: whatsappman ${c}`);
    }
  }
  assert.deepEqual(bad, [], `docs cite commands the CLI does not define: ${bad.join(', ')}`);
});

test('every flag cited in any doc exists in the CLI', () => {
  const bad: string[] = [];
  for (const f of DOCS) {
    for (const fl of citationsIn(read(f)).flags) {
      if (!VALID_FLAGS.has(fl)) bad.push(`${f}: ${fl}`);
    }
  }
  assert.deepEqual(bad, [], `docs cite flags the CLI parser does not recognise: ${bad.join(', ')}`);
});
