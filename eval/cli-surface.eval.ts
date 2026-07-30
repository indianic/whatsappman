import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI grows a command at a time, and the things that quietly rot are the
 * ones no unit test touches: a command that never makes it into `help`, one
 * that never gets documented, or a prompt hand-rolled in a corner so it behaves
 * differently from every other prompt. These evals hold the *surface* together:
 * every command is discoverable and documented, and every interaction goes
 * through the one prompt layer that guarantees you can always cancel.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const cliIndex = read('src/cli/index.ts');

const commandsBlock = cliIndex.match(/const COMMANDS = \[([\s\S]*?)\];/);
assert.ok(commandsBlock, 'could not find the COMMANDS array in src/cli/index.ts');
const COMMANDS = [...commandsBlock[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

/**
 * Aliases documented alongside their primary command, so they need no row of
 * their own. There is deliberately no "exempt from docs" list beyond this: the
 * first version of this eval excused seven commands from the documentation
 * check, and six of them turned out to be documented already — the exemption
 * was not protecting anything, it was just quietly weakening the eval. The
 * seventh (`version`) was a real gap the exemption had been hiding.
 */
const ALIAS_OF: Record<string, string> = { upgrade: 'update', list: 'numbers' };
const NO_DOC_ROW = new Set<string>();

test('the CLI parsed into a plausible command surface', () => {
  assert.ok(COMMANDS.length >= 20, `only parsed ${COMMANDS.length} commands`);
});

test('every command appears in `whatsappman help`', () => {
  // A command absent from help is a command nobody finds.
  const help = cliIndex.match(/function printHelp\(\): void \{([\s\S]*?)\n\}/);
  assert.ok(help, 'printHelp not found');
  const body = help[1];
  const missing = COMMANDS.filter((c) => {
    if (ALIAS_OF[c]) return false; // shown alongside its primary
    return !new RegExp(`\\b${c}\\b`).test(body);
  });
  assert.deepEqual(missing, [], `commands missing from help: ${missing.join(', ')}`);
});

test('every command is documented in docs/CLI.md', () => {
  const doc = read('docs/CLI.md');
  const missing = COMMANDS.filter((c) => {
    if (ALIAS_OF[c] || NO_DOC_ROW.has(c)) return false;
    return !new RegExp(`whatsappman ${c}\\b`).test(doc);
  });
  assert.deepEqual(missing, [], `commands undocumented in docs/CLI.md: ${missing.join(', ')}`);
});

test('no command prompts with raw readline — every prompt goes through prompts.ts', () => {
  // A hand-rolled readline prompt is how "type 1", 'type "yes"' and three
  // different cancel behaviours crept in. One layer means one way to cancel,
  // and cancel never counting as consent.
  const dir = path.join(ROOT, 'src/cli');
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /from 'node:readline'|require\('node:readline'\)/.test(readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, [], `raw readline prompts in: ${offenders.join(', ')}`);
});

test('the interactive layer always offers a way out', () => {
  const prompts = read('src/cli/prompts.ts');
  assert.match(prompts, /CANCEL_HINT/, 'a cancel hint must exist');
  // Each helper must surface the hint, so no prompt can appear without one.
  for (const helper of ['selectOne', 'askText', 'confirmDestructive']) {
    assert.ok(prompts.includes(helper), `prompts.ts must export ${helper}`);
  }
  const hintUses = [...prompts.matchAll(/CANCEL_HINT/g)].length;
  assert.ok(hintUses >= 4, `every prompt helper must show the cancel hint (found ${hintUses} uses)`);
});

test('destructive confirmations default to NO and treat cancel as NO', () => {
  // Panicking out of a prompt that wipes credentials must not be read as yes.
  const prompts = read('src/cli/prompts.ts');
  const fn = prompts.match(/export async function confirmDestructive[\s\S]*?\n\}/);
  assert.ok(fn, 'confirmDestructive not found');
  assert.match(fn[0], /initialValue:\s*false/, 'must default to No');
  assert.match(fn[0], /!isCancel\(answer\)/, 'cancel must not count as consent');
});

test('the destructive commands actually use that confirmation', () => {
  for (const [file, cmd] of [
    ['src/cli/sessions.ts', 'delete'],
    ['src/cli/reset.ts', 'reset'],
  ] as const) {
    assert.match(read(file), /confirmDestructive\(/, `${cmd} must confirm through the shared helper`);
  }
});
