#!/usr/bin/env node
/**
 * Cross-platform CLI smoke test, run against a GLOBALLY INSTALLED whatsappman.
 *
 * One list of assertions, two callers:
 *   - eval/docker-linux.eval.ts  — inside a throwaway Linux container
 *   - .github/workflows/ci.yml   — natively on ubuntu, macos AND windows
 *
 * Sharing it is the point: two divergent smoke lists would drift, and the
 * platform we most need covered (Windows) is the one nobody runs by hand.
 *
 * Everything here is spawned through a shell. On Windows the global binary is
 * `whatsappman.cmd`, and CreateProcess cannot execute a batch file directly —
 * the same trap that broke `whatsappman run` on Windows.
 */
import { execSync } from 'node:child_process';
import process from 'node:process';

const IS_WIN = process.platform === 'win32';
let failures = 0;

/**
 * Run the CLI, capturing output and exit code without throwing.
 *
 * This goes through a shell deliberately, and safely: `args` is only ever a
 * string literal written in this file — there is no user, network or argv input
 * anywhere in this script — while on Windows the global binary is
 * `whatsappman.cmd`, which CreateProcess cannot execute without one.
 */
function cli(args) {
  try {
    const stdout = execSync(`whatsappman ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout ?? '') + String(err.stderr ?? ''),
    };
  }
}

function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (!ok && typeof r === 'string') detail = r;
  } catch (err) {
    detail = String(err?.message ?? err);
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log(`== whatsappman smoke on ${process.platform}/${process.arch} ==`);

console.log('-- the published package installs and runs --');
check('version prints', () => cli('version').out.trim().length > 0);
check('help lists send-bulk', () => cli('help').out.includes('send-bulk'));
check('help lists summary', () => cli('help').out.includes('summary'));

console.log('-- autostart mechanism matches the platform --');
const plan = cli('daemon install --print').out.toLowerCase();
const expected = IS_WIN ? /schtasks/ : process.platform === 'darwin' ? /launchd/ : /systemd|openrc|nohup/;
const forbidden = IS_WIN
  ? /launchd|systemd/
  : process.platform === 'darwin'
    ? /schtasks|systemd/
    : /launchd|schtasks/;
check(`picks the ${process.platform} mechanism`, () => expected.test(plan) || `got: ${plan.slice(0, 120)}`);
check('does not pick another platform mechanism', () => !forbidden.test(plan) || `got: ${plan.slice(0, 120)}`);

console.log('-- run: exit codes propagate (the scripting contract) --');
// `npm test`-shaped invocation: on Windows npm is a .cmd shim, which is exactly
// what a shell-less spawn cannot execute.
check('run executes a command', () => cli('run -- node -e "console.log(1)"').code === 0);
check('run propagates a non-zero exit', () => cli('run -- node -e "process.exit(7)"').code === 7);
check('run propagates a zero exit', () => cli('run -- node -e "process.exit(0)"').code === 0);

console.log('-- graceful on a machine with no state --');
check('summary does not crash', () => {
  const r = cli('summary');
  return /nothing to summarise|no AI coding sessions|Work summary/i.test(r.out) || `got: ${r.out.slice(0, 120)}`;
});
check('status works with the daemon down', () => /daemon|running|stopped/i.test(cli('status').out));

console.log('-- no prompt blocks without a TTY (CI, pipes, MCP hosts) --');
for (const cmd of ['rename', 'delete', 'settings set']) {
  check(`${cmd} exits instead of hanging`, () => {
    const r = cli(cmd);
    return /pass one|usage|real terminal/i.test(r.out) || `got: ${r.out.slice(0, 120)}`;
  });
}

console.log('-- daemon lifecycle --');

/**
 * Poll for a condition instead of sleeping a fixed span. The daemon is usually
 * up in well under a second, so a flat `sleep 4` spent most of its time waiting
 * for nothing — and would still have been too short on a slow CI runner. This
 * is both faster in the common case and more tolerant in the bad one.
 */
async function waitFor(predicate, timeoutMs = 15_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Match the POSITIVE form: a bare "running" also matches "not running".
const isUp = () => /running \(pid/.test(cli('status').out);

cli('start');
const started = await waitFor(isUp);
check('daemon starts and reports a pid', () => started);

cli('stop');
const stopped = await waitFor(() => !isUp());
check('daemon stops', () => stopped);

console.log(`RESULT:${failures}`);
process.exit(failures === 0 ? 0 : 1);
