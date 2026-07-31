import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI's contract with everything outside it.
 *
 * A website can be rendered and inspected — open it, read the DOM, and you have
 * what a visitor sees. A CLI has no such artefact. Everything a caller can
 * observe passes through one narrow boundary:
 *
 *     argv  ->  ( stdout , stderr , exit code )
 *
 * The other evals in this directory check *internal* consistency: commands
 * agree with docs, tools map to handlers, schemas are well-formed. All of that
 * sits upstream of this boundary. These pin the boundary itself.
 *
 * It matters more here than for most CLIs because WhatsAppMan is built to run
 * **unattended** — `whatsappman run -- ./deploy.sh` in CI, a cron digest, an
 * agent loop. Those run with no human watching, no terminal attached, and a
 * caller that reads the exit code and nothing else.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every runtime .ts under src/, as [repo-relative path, source]. */
function srcFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) out.push([rel, read(rel)]);
    }
  };
  walk('src');
  return out;
}

const SRC = srcFiles();

test('the source parsed into a plausible surface', () => {
  // Guard the guard: if this walk breaks, every assertion below passes
  // vacuously and the file silently stops testing anything.
  assert.ok(SRC.length >= 20, `only walked ${SRC.length} source files`);
  assert.ok(
    SRC.some(([f]) => f === 'src/cli/index.ts'),
    'did not reach the CLI entrypoint',
  );
});

/* ── B1: exit codes mean something ───────────────────────────────────────── */

/**
 * The contract that makes `whatsappman send … && ./deploy.sh` safe to write:
 *
 *   0    it worked
 *   1    it declined cleanly — not connected, nothing to do, you said no
 *   130  interrupted (SIGINT), the POSIX 128 + signal convention
 *
 * The failure this prevents is the worst one a CLI has: **exit 0 on failure**.
 * A caller chained with `&&` then proceeds as if the message was delivered.
 */
const ALLOWED_EXIT = new Set([0, 1, 130]);

test('every exit code is one the documented contract defines', () => {
  const rogue: string[] = [];
  for (const [file, src] of SRC) {
    for (const m of src.matchAll(/process\.exit\((\d+)\)/g)) {
      if (!ALLOWED_EXIT.has(Number(m[1]))) rogue.push(`${file}: exit(${m[1]})`);
    }
  }
  assert.deepEqual(
    rogue,
    [],
    `exit codes outside {0,1,130} — a caller cannot tell these apart from a crash: ${rogue.join(', ')}`,
  );
});

test('the CLI exits with whatever its command handler returned', () => {
  // Command handlers return a number; the entrypoint is the single place that
  // turns it into an exit code. If that ever becomes a bare `process.exit(0)`
  // after the await, every non-zero return is silently swallowed and every
  // failure looks like success.
  const entry = read('src/index.ts');
  assert.match(
    entry,
    /process\.exit\(await cliMain\(/,
    'src/index.ts must exit with the value cliMain returned, not a literal',
  );
});

test('an unexpected throw exits non-zero', () => {
  // An uncaught error must not fall off the end of the process and exit 0.
  const entry = read('src/index.ts');
  const tail = entry.slice(entry.indexOf('catch'));
  assert.match(tail, /process\.exit\(1\)/, 'the top-level catch must exit 1');
});

/* ── B2: stream discipline ───────────────────────────────────────────────── */

test('nothing in src writes with console.log', () => {
  // stdout is the data channel: `whatsappman recent | jq` has to work, and a
  // stray debug line lands in the middle of the pipe. Human output goes through
  // tree.ts, machine output through an explicit process.stdout.write.
  const offenders = SRC.filter(([, src]) => /(^|[^.\w])console\.log\s*\(/.test(src)).map(([f]) => f);
  assert.deepEqual(offenders, [], `console.log in: ${offenders.join(', ')} — render through tree.ts instead`);
});

test('diagnostics go to stderr, never stdout', () => {
  // The crash handler and the config-recovery notice are commentary, not data.
  // On stdout they corrupt whatever the caller was parsing.
  assert.match(read('src/index.ts'), /process\.stderr\.write/, 'the crash handler must write to stderr');
  assert.match(read('src/config/store.ts'), /process\.stderr\.write/, 'the recovery notice must write to stderr');
});

/* ── B3: never hang without a TTY ────────────────────────────────────────── */

/**
 * This is the highest-consequence invariant in the file, because the failure is
 * silent and unbounded. An interactive prompt with no terminal attached does
 * not error — it **waits forever**. In cron or CI that is a hung job producing
 * no output and no exit code until something external kills it.
 *
 * The prompt helpers deliberately do NOT self-guard (they are also used behind
 * a guard that has already been checked, and double-reporting reads badly), so
 * the contract is: any file that prompts must first call canPrompt().
 */
const PROMPT_HELPERS = ['selectOne', 'askText', 'confirmDestructive'];

test('every file that prompts also guards on a TTY', () => {
  const unguarded: string[] = [];
  for (const [file, src] of SRC) {
    if (file === 'src/cli/prompts.ts') continue; // the layer itself
    const prompts = PROMPT_HELPERS.filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(src));
    if (prompts.length && !src.includes('canPrompt')) {
      unguarded.push(`${file} (uses ${prompts.join(', ')})`);
    }
  }
  assert.deepEqual(
    unguarded,
    [],
    `these prompt with no canPrompt() guard and will hang forever in cron/CI: ${unguarded.join('; ')}`,
  );
});

test('the prompt library is reached only through prompts.ts', () => {
  // Importing @clack/prompts directly bypasses the cancel-hint, the
  // cancel-is-never-consent rule, and the TTY guard in one go.
  const direct = SRC.filter(([f, src]) => f !== 'src/cli/prompts.ts' && /from '@clack\/prompts'/.test(src)).map(
    ([f]) => f,
  );
  assert.deepEqual(direct, [], `these bypass the prompt layer: ${direct.join(', ')}`);
});

test('canPrompt fails loudly rather than returning a default', () => {
  // Returning "true" or a silent default when there is no TTY would turn a hang
  // into something worse: an unattended run that answers its own prompt.
  const prompts = read('src/cli/prompts.ts');
  const body = prompts.slice(prompts.indexOf('export function canPrompt'));
  assert.match(body, /isInteractiveTerminal\(\)/, 'canPrompt must consult the terminal');
  assert.match(body, /return false/, 'canPrompt must return false when it cannot prompt');
});

/* ── B4: no ANSI when the output is piped ────────────────────────────────── */

test('colour goes through picocolors, never a hand-written escape', () => {
  // picocolors disables itself when stdout is not a TTY (and honours NO_COLOR).
  // A literal \x1b[..m ignores both and writes escape codes into log files and
  // pipes, where they are noise at best and corruption at worst.
  const raw: string[] = [];
  for (const [file, src] of SRC) {
    // link.ts is the exception: it paints a QR code with explicit SGR colours
    // because the glyphs must be exact 256-palette black and white to scan.
    if (file === 'src/cli/link.ts') continue;
    if (/\\x1b\[|\\u001b\[|\\033\[/.test(src)) raw.push(file);
  }
  assert.deepEqual(raw, [], `hand-written ANSI escapes in: ${raw.join(', ')} — use picocolors`);
});

test('the QR renderer is the only place allowed raw ANSI, and says why', () => {
  // Pinning the exception so it stays deliberate: if the QR ever stops needing
  // exact colours, the escape hatch should close with it.
  const link = read('src/cli/link.ts');
  assert.match(link, /\\x1b\[|\\u001b\[/, 'link.ts no longer emits raw ANSI — remove its exemption above');
  assert.ok(
    /38;5;|48;5;/.test(link),
    'the QR must use the 256-colour palette: a 16-colour theme repaints black/white as grey and the code stops scanning',
  );
});
