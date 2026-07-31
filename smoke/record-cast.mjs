#!/usr/bin/env node
/**
 * Record a real terminal session driving the CLI, and produce something a
 * person can watch.
 *
 * `all-commands.mjs` proves every command behaves. It cannot show anyone what
 * using the tool actually looks like, and it deliberately runs with **no TTY**
 * so interactive commands hit their guards instead of hanging. That means the
 * entire rendered experience — the diamond-tree layout, the colours, the
 * alignment of the status block — is never exercised by any check we have.
 *
 * This fills that gap the same way `screenshots.mjs` does for the site: it does
 * not assert taste, it produces the artefact and lets you look. The commands run
 * under a **real PTY** via script(1), so picocolors enables itself and the
 * output is byte-for-byte what a user sees, not the stripped version a pipe
 * gets.
 *
 *   npm run cast                 # record + write smoke/cast/
 *
 * Output: an asciicast v2 file (replayable by asciinema) and a self-contained
 * HTML player with no external assets, so it opens from disk.
 *
 * ONLY read-only commands are recorded. Under a real TTY, `link` would draw a
 * QR and wait for a scan, and `delete` would open a menu — a recorder that
 * hangs on a prompt is worse than no recorder. Every entry below is safe to run
 * unattended against a live install, which is also why this is allowed outside
 * a container, unlike all-commands.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BIN = process.env.WAM_BIN || 'whatsappman';
const OUT = path.resolve(process.cwd(), 'smoke/cast');
const COLS = 92;
const ROWS = 30;

/**
 * The demo reel, in the order someone would actually meet the tool.
 * `why` is printed as a caption above each command in the player.
 */
const SCENES = [
  { cmd: 'version', why: 'which build am I on' },
  { cmd: 'doctor', why: 'is everything this needs actually present' },
  { cmd: 'status', why: 'is the daemon up, and which numbers are linked' },
  { cmd: 'numbers', why: 'the linked numbers, and which one is default' },
  { cmd: 'settings get', why: 'the knobs, including the bulk-send guard rails' },
  { cmd: 'recent', why: 'what has been sent — metadata only, never the text' },
  { cmd: 'scheduled', why: 'what is queued to go out later' },
  { cmd: 'help', why: 'the whole command surface' },
];

/** Commands that must never be recorded: they prompt, or they mutate. */
const FORBIDDEN = /^(link|relink|reconnect|disconnect|rename|delete|default|reset|stop|restart|send|send-bulk|me|presence|update|upgrade|init|register|run|start|daemon)\b/;

const unsafe = SCENES.filter((s) => FORBIDDEN.test(s.cmd));
if (unsafe.length) {
  console.error(`Refusing to record interactive or mutating commands: ${unsafe.map((s) => s.cmd).join(', ')}`);
  process.exit(2);
}

/**
 * Run one command attached to a pseudo-terminal.
 *
 * Node has no built-in PTY, and pulling in node-pty for a recorder would add a
 * native build step to a repo that deliberately has none. script(1) is present
 * on macOS and every Linux this supports, and gives the child a real TTY — the
 * whole point, since without one picocolors disables itself and the recording
 * shows a colourless approximation of the product.
 */
function runInPty(argsLine) {
  return new Promise((resolve) => {
    const cmd = `${BIN} ${argsLine}`;
    // BSD (macOS): script [-q] file command ...
    // GNU (Linux): script [-q] -c "command" file
    const isMac = process.platform === 'darwin';
    // stdin MUST NOT be a pipe. Node wires piped stdio to a socketpair, and
    // BSD script calls tcgetattr on its own stdin to clone the terminal
    // settings — on a socket that fails outright with "Operation not supported
    // on socket" and every recording comes back empty. /dev/null is a character
    // device, which it tolerates.
    const stdio = ['ignore', 'pipe', 'pipe'];
    const env = { ...process.env, COLUMNS: String(COLS), LINES: String(ROWS), FORCE_COLOR: '1' };
    const child = isMac
      ? spawn('script', ['-q', '/dev/null', 'sh', '-c', cmd], { stdio, env })
      : spawn('script', ['-qec', cmd, '/dev/null'], { stdio, env });

    let out = '';
    const started = Date.now();
    const timer = setTimeout(() => {
      out += '\r\n[recorder] timed out — killed\r\n';
      child.kill('SIGKILL');
    }, 30_000);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      // BSD script echoes the EOF it feeds the pty ("^D" + two backspaces)
      // before the command's own output. It is an artefact of the recorder,
      // not something the CLI printed.
      const cleaned = out.replace(/^\^D\x08*/, '');
      resolve({ out: cleaned, code: code ?? 0, ms: Date.now() - started });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ out: `[recorder] could not spawn script(1): ${e.message}\r\n`, code: 127, ms: 0 });
    });
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log(`== recording ${SCENES.length} scenes under a real PTY ==`);

/** asciicast v2: a header line, then [time, "o", data] events. */
const events = [];
const results = [];
let t = 0.4;

for (const scene of SCENES) {
  const r = await runInPty(scene.cmd);
  results.push({ ...scene, ...r });

  // The typed prompt line, then the output, then a beat to read it.
  events.push([t, 'o', `[38;5;244m$[0m [1mwhatsappman ${scene.cmd}[0m\r\n`]);
  t += 0.35;
  events.push([t, 'o', r.out.replace(/\n/g, '\r\n')]);
  t += Math.min(3.2, 1.1 + r.out.split('\n').length * 0.045);
  events.push([t, 'o', '\r\n']);
  t += 0.25;

  const status = r.code === 0 ? 'ok' : `exit ${r.code}`;
  console.log(`  recorded ${scene.cmd.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${status}`);
}

const header = {
  version: 2,
  width: COLS,
  height: ROWS,
  title: 'whatsappman — a real terminal session',
  env: { SHELL: '/bin/sh', TERM: 'xterm-256color' },
};
const castPath = path.join(OUT, 'session.cast');
writeFileSync(castPath, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');

/* ── the player ────────────────────────────────────────────────────────────
 * Self-contained: the cast is inlined, the ANSI-to-HTML conversion is ~40 lines,
 * and nothing is fetched. It opens from disk with no server and no network,
 * which is the only way an artefact like this actually gets looked at.
 */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The 256-colour palette entries the CLI actually uses, plus the basic 8. */
const BASIC = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf'];
const BRIGHT = ['#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

function ansiToHtml(raw) {
  let html = '';
  let open = false;
  let i = 0;
  while (i < raw.length) {
    const m = /^\[([0-9;]*)m/.exec(raw.slice(i));
    if (m) {
      const codes = m[1].split(';').filter(Boolean).map(Number);
      if (open) {
        html += '</span>';
        open = false;
      }
      const style = [];
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 1) style.push('font-weight:700');
        else if (c === 2) style.push('opacity:.62');
        else if (c === 3) style.push('font-style:italic');
        else if (c >= 30 && c <= 37) style.push(`color:${BASIC[c - 30]}`);
        else if (c >= 90 && c <= 97) style.push(`color:${BRIGHT[c - 90]}`);
        else if ((c === 38 || c === 48) && codes[k + 1] === 5) {
          const n = codes[k + 2];
          const prop = c === 38 ? 'color' : 'background';
          style.push(`${prop}:${xterm256(n)}`);
          k += 2;
        }
      }
      if (style.length) {
        html += `<span style="${style.join(';')}">`;
        open = true;
      }
      i += m[0].length;
      continue;
    }
    // Drop cursor/erase sequences the recorder picks up; they mean nothing here.
    const other = /^\[[0-9;?]*[A-Za-z]/.exec(raw.slice(i));
    if (other) {
      i += other[0].length;
      continue;
    }
    html += esc(raw[i] === '\r' ? '' : raw[i]);
    i++;
  }
  if (open) html += '</span>';
  return html;
}

function xterm256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const to = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${to(Math.floor(c / 36))},${to(Math.floor(c / 6) % 6)},${to(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const scenesHtml = results
  .map(
    (r) => `<section>
  <h2>whatsappman ${esc(r.cmd)}</h2>
  <p class="why">${esc(r.why)}</p>
  <div class="term"><pre>${ansiToHtml(r.out)}</pre></div>
  <p class="meta">exit ${r.code} · ${r.ms}ms</p>
</section>`,
  )
  .join('\n');

writeFileSync(
  path.join(OUT, 'index.html'),
  `<!doctype html><meta charset=utf-8><title>whatsappman — terminal session</title>
<style>
 :root{color-scheme:dark}
 body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:28px;background:#0b141a;color:#e6edf3}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8b98a5;margin:0 0 26px;font-size:13px}
 section{margin:0 0 26px;max-width:860px}
 h2{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 2px;color:#25D366}
 .why{margin:0 0 8px;color:#8b98a5;font-size:12.5px}
 .term{background:#111b21;border:1px solid #223039;border-radius:10px;padding:14px 16px;overflow-x:auto}
 pre{margin:0;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
 .meta{margin:6px 0 0;color:#5c6b76;font-size:11.5px}
 code{background:#111b21;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
<h1>whatsappman — a real terminal session</h1>
<p class="sub">${results.length} commands, recorded under a real PTY so the colours and layout are exactly what a user sees.
Replayable as <code>smoke/cast/session.cast</code> with <code>asciinema play</code>.</p>
${scenesHtml}`,
);

const failed = results.filter((r) => r.code !== 0);
console.log(`\ncast    → ${castPath}`);
console.log(`player  → ${path.join(OUT, 'index.html')}`);
if (failed.length) {
  console.log(`\n⚠️  ${failed.length} scene(s) exited non-zero: ${failed.map((f) => f.cmd).join(', ')}`);
  console.log('   Read-only commands should succeed against a healthy install.');
}
process.exit(0);
