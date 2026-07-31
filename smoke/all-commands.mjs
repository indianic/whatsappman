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
/**
 * `must` — patterns the output has to contain, whichever way the command went.
 *
 * "It didn't crash" is a low bar. A command that prints nothing at all, or
 * answers a completely different question, clears it. These say what the output
 * has to *be about*, without assuming success: the environment has no linked
 * number, so most of these decline, and the pattern has to hold either way.
 *
 * Two shapes are used deliberately:
 *
 *   /a|b/  — "worked, OR declined for the one reason it should decline for".
 *            `numbers` either lists a number or says none are linked. What it
 *            must never do is print an empty block or somebody else's error.
 *   /a/    — an unconditional claim. `version` prints a version. Always.
 *
 * A command whose only honest expectation is "some words came out" gets
 * SELF_IDENTIFYING instead, which is still stronger than a crash check: it
 * proves the command reached its own renderer rather than dying in argv
 * parsing or printing a bare error code with no sentence.
 */

/** Every human-facing command opens a tree block titled after itself. */
const selfTitled = (name) => new RegExp(`whatsappman\\s+—\\s+${name}\\b|┌`, 'i');

const INVOCATIONS = {
  version: { args: 'version', expect: 'ok', must: [/\b\d+\.\d+\.\d+\b/] },
  help: {
    args: 'help',
    expect: 'ok',
    // Help that lists no commands is the failure worth catching here.
    must: [/\bsend\b/, /\bstatus\b/, /\bdoctor\b/, /\blink\b/],
  },
  examples: { args: 'examples', expect: 'ok', must: [/whatsappman /, selfTitled('examples')] },
  doctor: {
    args: 'doctor',
    expect: 'graceful',
    // Doctor's whole job is a verdict. Sections without one are useless.
    must: [/runtime/i, /daemon/i, /doctor: (ok|issues found)/],
  },
  daemon: {
    args: 'daemon install --print',
    expect: 'graceful',
    // --print must show the unit it WOULD write, not install anything.
    must: [/launchd|systemd|schtasks|---/i],
  },
  start: { args: 'start', expect: 'graceful', must: [/daemon|running|started|already/i] },
  status: {
    args: 'status',
    expect: 'graceful',
    must: [/daemon/i, /running|not running|down/i],
  },
  numbers: {
    args: 'numbers',
    expect: 'graceful',
    must: [/connected|disconnected|none linked|no numbers/i],
  },
  recent: { args: 'recent', expect: 'graceful', must: [/recent|none|no sends/i] },
  scheduled: { args: 'scheduled', expect: 'graceful', must: [/scheduled|none|no pending/i] },
  settings: {
    args: 'settings get',
    expect: 'graceful',
    // Named keys, not just the word "settings" — this is what proves the
    // subcommand was parsed rather than swallowed as an unknown command.
    must: [/draftTtlMinutes|alwaysConfirm|maxBulkRecipients/],
  },
  register: { args: 'register', expect: 'graceful', must: [/claude|cursor|mcp|config|register/i] },
  summary: { args: 'summary', expect: 'graceful', must: [/summary|digest|session|no sessions/i] },
  // `run` must report a verdict on the command it wrapped, and — since no
  // --to was given — say that nothing was sent. Reporting neither would make it
  // indistinguishable from a no-op wrapper.
  run: { args: 'run -- node -e "0"', expect: 'ok', must: [/result/i, /success|failed|exit \d/i, /nothing sent|--to/i] },
  // No TTY here, so each of these must hit its guard instead of hanging. The
  // guard has to SAY so — "run it in a real terminal" — because a command that
  // exits 1 silently in CI tells the operator nothing about why.
  link: { args: 'link', expect: 'graceful', must: [/terminal|tty|--image|qr/i] },
  relink: { args: 'relink', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  reconnect: { args: 'reconnect', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  disconnect: { args: 'disconnect', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  rename: { args: 'rename', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  delete: { args: 'delete', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  default: { args: 'default', expect: 'graceful', must: [/terminal|tty|label|session|number/i] },
  // No linked number: these must SAY that, not crash and not silently no-op.
  send: {
    args: 'send "+10000000000" "smoke"',
    expect: 'graceful',
    must: [/not connected|no number|not linked|daemon|session/i],
  },
  'send-bulk': {
    args: 'send-bulk "smoke" --to "+10000000000"',
    expect: 'graceful',
    must: [/not connected|no number|not linked|daemon|session|recipient/i],
  },
  presence: {
    args: 'presence "+10000000000" typing',
    expect: 'graceful',
    must: [/not connected|no number|not linked|daemon|session|presence/i],
  },
  // "no default number set" is the honest answer in a fresh environment, and
  // it names the command that fixes it. The pattern has to allow it.
  me: {
    args: 'me "smoke"',
    expect: 'graceful',
    must: [/not connected|no (default )?number|not linked|daemon|session/i],
  },
  init: { args: 'init --help', expect: 'graceful', must: [/init|usage|daemon|link/i] },
  restart: { args: 'restart', expect: 'graceful', must: [/daemon|restart|running|stopped/i] },
  stop: { args: 'stop', expect: 'graceful', must: [/daemon|stop|not running/i] },
  // Network + mutates the install; exercised for crash-safety only.
  update: { args: 'update', expect: 'graceful', slow: true, must: [/up to date|updating|version|npm|network/i] },
  upgrade: { args: 'upgrade', expect: 'graceful', slow: true, must: [/up to date|upgrad|version|npm|network/i] },
  // Destructive: wipes the config dir. Harmless in a throwaway environment,
  // and it runs last so nothing after it depends on that state.
  reset: { args: 'reset', expect: 'graceful', last: true, must: [/reset|cancel|removed|confirm|terminal|tty/i] },
};

/** Fallback when a command has no honest content-specific expectation. */
const SELF_IDENTIFYING = [/\S{3,}/];

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

// Every command must state what its output should look like. Without this, a
// command added tomorrow silently inherits the weakest possible check — it
// would be listed as passing while only ever being tested for not crashing.
const noExpectation = Object.entries(INVOCATIONS)
  .filter(([, s]) => !Array.isArray(s.must) || s.must.length === 0)
  .map(([n]) => n);
if (noExpectation.length === 0) ok(`all ${Object.keys(INVOCATIONS).length} invocations declare an output expectation`);
else bad(`commands checked only for not-crashing (add \`must\`): ${noExpectation.join(', ')}`);

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

  // Did it actually answer its own question?
  //
  // Everything above proves the process behaved. None of it proves the command
  // DID anything: `status` printing an empty block, or `settings get` being
  // swallowed as an unknown command, passes every check so far. Strip ANSI
  // first — under a TTY the tree renderer colours its output, and a pattern
  // like /daemon/ must not fail because an escape sequence split the word.
  const text = r.out.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = spec.must ?? SELF_IDENTIFYING;
  const unmet = patterns.filter((re) => !re.test(text));
  if (unmet.length) {
    const shown = text.trim().split('\n').slice(0, 3).join(' / ').slice(0, 110) || '(no output at all)';
    bad(`${name} produced output that does not match ${unmet.join(', ')} — got: ${shown}`);
    continue;
  }

  ok(`${name} ${r.code === 0 ? 'ok' : 'declined cleanly'} + said something meaningful`);
}

console.log(`RESULT:${failures}`);
process.exit(failures === 0 ? 0 : 1);
