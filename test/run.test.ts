import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayCommand, lastLines, formatRunOutcome, type RunOutcome } from '../src/cli/run.ts';
import { resolveProjectDir, summaryHeading } from '../src/cli/summary.ts';

const base: RunOutcome = {
  command: 'npm test',
  code: 0,
  signal: null,
  durationMs: 134_000,
  tail: '',
  cwd: '/Users/k/App',
  host: 'mac',
};

test('displayCommand re-quotes args that a flat join would make ambiguous', () => {
  // The bug this guards: `run -- sh -c "exit 3"` displayed as `sh -c exit 3`
  // reads as a different command than the one that ran.
  assert.equal(displayCommand(['sh', '-c', 'exit 3']), 'sh -c "exit 3"');
  assert.equal(displayCommand(['npm', 'test']), 'npm test', 'simple args stay unquoted');
  assert.equal(displayCommand(['echo', 'a && b']), 'echo "a && b"');
});

test('lastLines keeps only the tail, within both line and char budgets', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const tail = lastLines(text, 5);
  assert.equal(tail.split('\n').length, 5);
  assert.match(tail, /line 49$/);
  assert.ok(!tail.includes('line 44'), 'older lines dropped');
  assert.equal(lastLines('   \n  '), '', 'blank output yields nothing to attach');
  const long = lastLines('x'.repeat(5000), 10, 100);
  assert.ok(long.length <= 101, 'char budget enforced');
});

test('a successful run is a single calm line with no output dump', () => {
  const out = formatRunOutcome(base);
  assert.match(out, /^✅ `npm test` finished in 2m/);
  assert.ok(!out.includes('```'), 'success attaches no output');
  assert.match(out, /mac:\/Users\/k\/App/, 'says where it ran');
});

test('a failed run carries the exit code AND the output tail', () => {
  // "it failed" with no error is a notification you must walk to your desk to act on.
  const out = formatRunOutcome({ ...base, code: 1, tail: 'ERROR: boom' });
  assert.match(out, /^❌ `npm test` failed/);
  assert.match(out, /exit 1/);
  assert.match(out, /ERROR: boom/);
});

test('a killed run names the signal instead of a misleading exit code', () => {
  const out = formatRunOutcome({ ...base, code: null, signal: 'SIGKILL', tail: 'x' });
  assert.match(out, /killed by SIGKILL/);
  assert.ok(!out.includes('exit null'));
});

test('--quiet suppresses the output tail on failure', () => {
  const out = formatRunOutcome({ ...base, code: 2, tail: 'secret build log' }, { quiet: true });
  assert.match(out, /failed/);
  assert.ok(!out.includes('secret build log'), 'quiet must not attach captured output');
});

test('resolveProjectDir matches a friendly name, encoded dir, or substring', () => {
  const dirs = ['-Users-k-Sites-WhatsAppMan', '-Users-k-Sites-mcphub', '-srv-pay-indianic-net'];
  assert.equal(resolveProjectDir(dirs, 'whatsappman'), '-Users-k-Sites-WhatsAppMan', 'case-insensitive trailing segment');
  assert.equal(resolveProjectDir(dirs, 'mcphub'), '-Users-k-Sites-mcphub');
  assert.equal(resolveProjectDir(dirs, '-srv-pay-indianic-net'), '-srv-pay-indianic-net', 'encoded dir accepted as-is');
  assert.equal(resolveProjectDir(dirs, 'sites'), '-Users-k-Sites-WhatsAppMan', 'substring falls back to first match');
  assert.equal(resolveProjectDir(dirs, 'nope'), null);
});

test('summaryHeading reflects the requested window', () => {
  const day = new Date(Date.UTC(2026, 6, 30, 12));
  assert.match(summaryHeading(1, day), /Work summary — 30 Jul 2026/);
  assert.match(summaryHeading(7, day), /last 7 days/);
  assert.match(summaryHeading(undefined, day), /30 Jul 2026/);
});

const { shouldUseShell } = await import('../src/cli/run.ts');

test('POSIX spawns multi-arg commands verbatim, so quoting cannot be lost', () => {
  assert.equal(shouldUseShell(['npm', 'test'], 'darwin'), false);
  assert.equal(shouldUseShell(['sh', '-c', 'exit 3'], 'linux'), false);
});

test('a single argument is the deliberate shell form on every platform', () => {
  // `run -- "a && b"` is someone explicitly asking for shell semantics.
  assert.equal(shouldUseShell(['echo a && echo b'], 'darwin'), true);
  assert.equal(shouldUseShell(['echo a && echo b'], 'linux'), true);
  assert.equal(shouldUseShell(['echo a && echo b'], 'win32'), true);
});

test('Windows always uses a shell — npm/npx/yarn are .cmd shims there', () => {
  // Without this, `run -- npm test` dies with ENOENT on Windows: CreateProcess
  // cannot execute a batch file directly. This is the branch no macOS run can
  // exercise, which is exactly why the rule is a pure function.
  assert.equal(shouldUseShell(['npm', 'test'], 'win32'), true);
  assert.equal(shouldUseShell(['yarn', 'build', '--prod'], 'win32'), true);
});
