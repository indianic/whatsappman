import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The assumptions that are invisible on the machine that wrote them.
 *
 * Every Windows bug this project has had was written on macOS, passed a fully
 * green local `verify`, and was caught by CI on Windows afterwards:
 *
 *   - `.cmd` shims cannot be spawned without a shell, so `run` failed outright
 *   - `encodeProjectDir` folded `/` and `.` but not `\` or `:`, so every
 *     Windows project mapped to the same mangled directory
 *
 * CI catching them is the system working. But the feedback loop is a push, a
 * queue and several minutes, and it only fires for code paths CI happens to
 * execute. A static rubric catches the same class in under a second on the
 * machine writing it.
 *
 * These must stay NARROW. `src/daemon/install.ts` legitimately contains
 * `/usr/bin`, `/opt/homebrew` and a shebang, because it generates launchd and
 * systemd units — POSIX artefacts by definition. A blunt "no POSIX paths" grep
 * would flag all of it and be switched off within a week. So each test below
 * targets a specific shape that is wrong *regardless* of platform intent.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

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
/** Source with comments stripped — prose about POSIX is not a POSIX assumption. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the source parsed into a plausible surface', () => {
  assert.ok(SRC.length >= 20, `only walked ${SRC.length} files`);
});

test('config paths are composed with path.join, never string concatenation', () => {
  // `baseDir() + '/logs'` works on macOS and Linux and produces a path with a
  // mixed separator on Windows. path.join is the only portable composition.
  const offenders: string[] = [];
  for (const [file, src] of SRC) {
    for (const m of code(src).matchAll(/\b(baseDir|sessionsDir|logsDir|sessionDir)\(\)\s*\+\s*['"`]/g)) {
      offenders.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `config paths built by concatenation: ${offenders.join(', ')} — use path.join`);
});

test('no runtime file hardcodes the POSIX home directory', () => {
  // '~/...' is not expanded by Node, and $HOME is not the variable Windows
  // uses. Both silently produce a path that does not exist rather than failing.
  const offenders: string[] = [];
  for (const [file, src] of SRC) {
    const c = code(src);
    if (/['"`]~\//.test(c)) offenders.push(`${file}: literal ~/`);
    if (/process\.env\.HOME\b/.test(c) && !/USERPROFILE/.test(c)) {
      offenders.push(`${file}: $HOME with no USERPROFILE fallback`);
    }
  }
  assert.deepEqual(offenders, [], `POSIX home assumptions: ${offenders.join(', ')} — use os.homedir()`);
});

test('the temp directory comes from the OS, not a literal /tmp', () => {
  const offenders = SRC.filter(([, src]) => /['"`]\/tmp\//.test(code(src))).map(([f]) => f);
  assert.deepEqual(offenders, [], `literal /tmp in: ${offenders.join(', ')} — use os.tmpdir()`);
});

test('every path-encoding helper folds the Windows separators too', () => {
  // The exact bug: encodeProjectDir folded / and . but not \ or :, so
  // C:\Users\me\proj and C:\Users\me\other collapsed together on Windows while
  // being perfectly distinct on macOS.
  const digest = read('src/digest.ts');
  const m = digest.match(/export function encodeProjectDir[\s\S]*?\n\}/);
  assert.ok(m, 'encodeProjectDir not found');
  const charClass = m[0].match(/replace\(\/\[([^\]]+)\]\//);
  assert.ok(charClass, 'encodeProjectDir no longer folds a character class');
  for (const ch of ['/', '\\\\', '\\.', ':']) {
    assert.ok(
      charClass[1].includes(ch.replace('\\\\', '\\\\')) || charClass[1].includes(ch),
      `encodeProjectDir does not fold ${ch} — Windows paths will collide`,
    );
  }
});

test('spawning honours the Windows shell requirement', () => {
  // On Windows a globally installed CLI is a `.cmd` shim, which CreateProcess
  // cannot execute directly — spawn must go through a shell. This was a real
  // failure, not a precaution.
  const run = read('src/cli/run.ts');
  assert.match(run, /shouldUseShell/, 'run.ts must decide shell usage explicitly');
  const fn = run.slice(run.indexOf('export function shouldUseShell'));
  assert.match(fn, /win32/, "shouldUseShell must special-case win32 — .cmd shims can't spawn without a shell");
});

test('every platform branch that names darwin or linux also answers for win32', () => {
  // A chain of `if (platform === 'darwin') … if (platform === 'linux') …` with
  // no Windows arm does not throw. It falls through and returns undefined,
  // which surfaces later as an unrelated error a long way from the cause.
  const offenders: string[] = [];
  for (const [file, src] of SRC) {
    const c = code(src);
    const namesPosix = /'darwin'|'linux'/.test(c);
    if (namesPosix && !/'win32'/.test(c)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these branch on POSIX platforms with no win32 arm: ${offenders.join(', ')}`,
  );
});

test('every chmod tolerates a filesystem without POSIX permissions', () => {
  // POSIX modes do not apply on Windows (or on FAT/exFAT volumes, or some
  // network mounts). The hazard is not that the permission fails to apply —
  // that is expected, and Windows restricts the user profile by other means —
  // it is that an unguarded chmod throws and takes down the surrounding flow:
  // linking, writing config, rotating the daemon token. Each of those is
  // load-bearing and none of them should die because a mode could not be set.
  //
  // So the rule is the try/catch, not a `win32` string. An earlier draft of
  // this eval demanded the literal and flagged all three call sites, which were
  // already correct — the eval was wrong, so the eval changed.
  const offenders: string[] = [];
  for (const [file, src] of SRC) {
    const c = code(src);
    for (const m of [...c.matchAll(/\bfs\.chmodSync\(|\bchmodSync\(|\bfs\.chmod\(/g)]) {
      const before = c.slice(Math.max(0, m.index - 150), m.index);
      const after = c.slice(m.index, m.index + 200);
      const wrapped = /try\s*\{[^}]*$/.test(before) && /catch/.test(after);
      if (!wrapped) offenders.push(`${file}@${m.index}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `unguarded chmod in: ${offenders.join(', ')} — wrap in try/catch; it throws where POSIX modes do not exist`,
  );
});

test('the IPC endpoint has a Windows form', () => {
  // Unix domain sockets do not exist on Windows; without a named-pipe branch
  // the daemon simply cannot be reached there.
  const paths = read('src/config/paths.ts');
  const fn = paths.slice(paths.indexOf('export function socketPath'));
  assert.match(fn, /win32/, 'socketPath must branch on win32');
  assert.match(fn, /pipe/, 'Windows needs a named pipe, not a socket file');
});

test('CI actually runs on all three platforms', () => {
  // The whole argument for the tests above is that they are cheap and CI is the
  // backstop. If the Windows leg of the matrix ever disappears, these rubrics
  // become the *only* Windows verification and that should be a deliberate
  // choice, not something that happens quietly.
  const ci = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu', 'macos', 'windows']) {
    assert.match(ci, new RegExp(os), `CI matrix no longer covers ${os}`);
  }
});

test('the cross-OS support claim is documented', () => {
  // The site and README both promise macOS, Windows and Linux. Where that is
  // substantiated needs to stay findable, or the claim is just marketing.
  const doc = read('docs/CROSS-OS.md');
  for (const os of [/macOS/i, /Windows/i, /Linux/i]) {
    assert.match(doc, os, `docs/CROSS-OS.md no longer covers ${os}`);
  }
});
