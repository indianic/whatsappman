#!/usr/bin/env node
/**
 * Exercise EVERY CLI command against a real installed binary.
 *
 * The existing assertion list drives 8 of 31 commands. The other 23 have never
 * been executed by anything but a human — so a command that throws instead of
 * failing gracefully (a missing import, an undefined access on an empty config,
 * a crash when no number is linked) ships unnoticed.
 *
 * The command list is DERIVED from the CLI's own COMMANDS array, not written
 * here. A command added tomorrow is automatically required to behave, and a
 * command removed stops being tested — the list cannot drift out of date.
 *
 * WHAT "PASS" MEANS. Almost nothing here can succeed: the environment has no
 * linked number, no WhatsApp session, sometimes no daemon. That is the point.
 * Every command must either work or **fail like a program that expected this** —
 * a clean message and exit 0/1. What fails the check is a crash: a stack trace,
 * an unhandled rejection, or an exit code that means the process died rather
 * than declined.
 *
 * Run inside the container (`npm run smoke`) or against a local install:
 *   node smoke/all-commands.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BIN = process.env.WAM_BIN || 'whatsappman';

/**
 * Safe invocation per command. `expect` is what a healthy program does here:
 *   'ok'     — must exit 0
 *   'graceful' — may fail, but must do so cleanly (exit 0 or 1, no stack)
 * Commands are ordered so lifecycle ones run coherently and `reset` runs last.
 */
const INVOCATIONS = {
  version: { args: 'version', expect: 'ok' },
  help: { args: 'help', expect: 'ok' },
  examples: { args: 'examples', expect: 'ok' },
  doctor: { args: 'doctor', expect: 'graceful' },
  daemon: { args: 'daemon install --print', expect: 'graceful' },
  start: { args: 'start', expect: 'graceful' },
  status: { args: 'status', expect: 'graceful' },
  numbers: { args: 'numbers', expect: 'graceful' },
  recent: { args: 'recent', expect: 'graceful' },
  scheduled: { args: 'scheduled', expect: 'graceful' },
  settings: { args: 'settings get', expect: 'graceful' },
  register: { args: 'register', expect: 'graceful' },
  summary: { args: 'summary', expect: 'graceful' },
  run: { args: 'run -- node -e "0"', expect: 'ok' },
  // No TTY here, so each of these must hit its guard instead of hanging.
  link: { args: 'link', expect: 'graceful' },
  relink: { args: 'relink', expect: 'graceful' },
  reconnect: { args: 'reconnect', expect: 'graceful' },
  disconnect: { args: 'disconnect', expect: 'graceful' },
  rename: { args: 'rename', expect: 'graceful' },
  delete: { args: 'delete', expect: 'graceful' },
  default: { args: 'default', expect: 'graceful' },
  // No linked number: these must report that, not crash.
  send: { args: 'send "+10000000000" "smoke"', expect: 'graceful' },
  'send-bulk': { args: 'send-bulk "smoke" --to "+10000000000"', expect: 'graceful' },
  presence: { args: 'presence "+10000000000" typing', expect: 'graceful' },
  me: { args: 'me "smoke"', expect: 'graceful' },
  init: { args: 'init --help', expect: 'graceful' },
  restart: { args: 'restart', expect: 'graceful' },
  stop: { args: 'stop', expect: 'graceful' },
  // Network + mutates the install; exercised for crash-safety only.
  update: { args: 'update', expect: 'graceful', slow: true },
  upgrade: { args: 'upgrade', expect: 'graceful', slow: true },
  // Destructive: wipes the config dir. Harmless in a throwaway environment,
  // and it runs last so nothing after it depends on that state.
  reset: { args: 'reset', expect: 'graceful', last: true },
};

/** Signs a process died rather than declined. */
const CRASH_MARKERS = [
  /^\s+at .+:\d+:\d+\)?$/m, // a stack frame
  /UnhandledPromiseRejection/i,
  /TypeError:|ReferenceError:|SyntaxError:/,
  /Cannot read propert/i,
  /is not a function/i,
  /ERR_MODULE_NOT_FOUND|Cannot find module/i,
];

function commandsFromSource() {
  // Derive from the CLI itself so this can never test a stale list.
  const candidates = [
    path.resolve(process.cwd(), 'src/cli/index.ts'),
    '/work/src/cli/index.ts',
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return null;
  const block = readFileSync(file, 'utf8').match(/const COMMANDS = \[([\s\S]*?)\];/);
  return block ? [...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]) : null;
}

/**
 * Runs through a shell deliberately, and safely: every `args` string is a
 * literal in the INVOCATIONS table above — there is no user, argv or network
 * input anywhere in this file — while on Windows the installed binary is
 * `whatsappman.cmd`, which CreateProcess cannot execute without one.
 */
function run(args, timeout) {
  try {
    const out = execSync(`${BIN} ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout ?? '') + String(err.stderr ?? ''),
      timedOut: err.killed === true || /ETIMEDOUT/.test(String(err.code)),
    };
  }
}

let failures = 0;
const ok = (m) => console.log(`  ok   - ${m}`);
const bad = (m) => {
  console.log(`  FAIL - ${m}`);
  failures++;
};

/**
 * Refuse to run against a real workstation.
 *
 * This list includes `stop`, `restart` and `reset`. Run on a developer machine
 * it will stop the daemon holding their live WhatsApp connection — which is
 * exactly what happened the first time it was executed here. Sandboxing HOME is
 * not enough: the daemon is a process, and stopping it does not care which
 * config dir you pointed at.
 *
 * So it runs only where breaking things is free: inside a container, in CI, or
 * with an explicit opt-in from someone who has read this.
 */
const inContainer = existsSync('/.dockerenv') || process.env.container != null;
const allowed = inContainer || process.env.CI === 'true' || process.env.WAM_SMOKE_ALLOW_LOCAL === '1';
if (!allowed) {
  console.error(
    'Refusing to run: this exercises stop/restart/reset and would kill a live daemon.\n' +
      'Run it in the container (npm run smoke), or set WAM_SMOKE_ALLOW_LOCAL=1 if you\n' +
      'genuinely want it against this machine.',
  );
  process.exit(2);
}

console.log(`== every CLI command, against ${BIN} ==`);

const declared = commandsFromSource();
if (declared) {
  const untested = declared.filter((c) => !INVOCATIONS[c]);
  if (untested.length === 0) ok(`all ${declared.length} declared commands have an invocation`);
  else bad(`commands with no invocation here (add one): ${untested.join(', ')}`);
} else {
  console.log('  note - source not reachable; testing the built-in list only');
}

const order = Object.entries(INVOCATIONS).sort(
  ([, a], [, b]) => Number(a.last ?? false) - Number(b.last ?? false),
);

for (const [name, spec] of order) {
  const r = run(spec.args, spec.slow ? 120_000 : 30_000);
  const crashed = CRASH_MARKERS.some((re) => re.test(r.out));

  if (r.timedOut) {
    bad(`${name} timed out — a command must never hang without a TTY`);
    continue;
  }
  if (crashed) {
    const line = r.out.split('\n').find((l) => CRASH_MARKERS.some((re) => re.test(l))) ?? '';
    bad(`${name} crashed: ${line.trim().slice(0, 90)}`);
    continue;
  }
  if (spec.expect === 'ok' && r.code !== 0) {
    bad(`${name} should have succeeded, exited ${r.code}`);
    continue;
  }
  if (r.code > 1) {
    bad(`${name} exited ${r.code} — expected 0 (worked) or 1 (declined cleanly)`);
    continue;
  }
  ok(`${name} ${r.code === 0 ? 'ok' : 'declined cleanly'}`);
}

console.log(`RESULT:${failures}`);
process.exit(failures === 0 ? 0 : 1);
