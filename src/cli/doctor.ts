import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { intro, outro, section, fact, row, attention } from './tree.js';
import { baseDir, socketPath, tokenPath } from '../config/paths.js';
import { detectMechanism, isInstalled, launcherPath } from '../daemon/install.js';
import { isDaemonAlive } from '../daemon/lock.js';
import { ping, request } from '../ipc/client.js';
import type { SessionSummary } from '../status.js';

function modeOf(p: string): number | null {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

function resolvable(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The dist entrypoint the generated launcher imports, or null if it can't be
 * read. The launcher is a tiny Node script whose only job is
 * `import("file:///…/dist/index.js")`, so the path it names is exactly what the
 * OS job will try to load at login. Pure string extraction — nothing is
 * executed. Exported for tests.
 */
export function launcherTarget(file: string = launcherPath()): string | null {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/import\(["']file:\/\/([^"']+)["']\)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** First line of `<cmd> --version`, or null when it isn't installed. */
function versionOf(cmd: string): string | null {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')[0]
      .trim();
  } catch {
    return null;
  }
}

/**
 * The copy-pasteable command that installs a missing prerequisite on this
 * platform. Pure + exported so the per-platform strings are testable from any
 * machine — the Windows and Linux branches are otherwise unverifiable here.
 *
 * These are PRINTED, never executed. Installing git needs administrator rights
 * and a system package manager; a CLI that silently runs `sudo apt install` (or
 * elevates on Windows) to fix its own prerequisite is doing something the user
 * did not ask for, on a machine it does not own.
 */
export function installHint(tool: string, platform: string = process.platform): string {
  if (tool === 'git') {
    if (platform === 'darwin') return 'xcode-select --install    (or: brew install git)';
    if (platform === 'win32') return 'winget install --id Git.Git -e    (or: https://git-scm.com/download/win)';
    return 'sudo apt install git    (or: sudo dnf install git)';
  }
  if (tool === 'node' || tool === 'npx' || tool === 'npm') {
    if (platform === 'darwin') return 'brew install node    (or: https://nodejs.org)';
    if (platform === 'win32') return 'winget install --id OpenJS.NodeJS.LTS -e    (or: https://nodejs.org)';
    return 'see https://nodejs.org/en/download/package-manager';
  }
  return `install ${tool} using your platform's package manager`;
}

/** Pre-flight environment + daemon checks. Read-only; never mutates anything.
 *  `--fix` adds the exact command to install anything missing. */
export async function runDoctor(fix = false): Promise<number> {
  intro('whatsappman — doctor');
  let ok = true;
  const missing: string[] = [];
  const bad = () => {
    ok = false;
  };

  section('runtime');
  const major = Number(process.versions.node.split('.')[0]);
  fact(`node ${process.versions.node}`, major >= 18);
  if (major < 18) {
    bad();
    missing.push('node');
  }
  const hasNode = resolvable('node');
  const hasNpx = resolvable('npx');
  fact(`node on PATH: ${hasNode ? 'yes' : 'no'}`, hasNode);
  fact(`npx on PATH: ${hasNpx ? 'yes' : 'no'}`, hasNpx);
  if (!hasNode || !hasNpx) {
    bad();
    missing.push('node');
  }

  section('dependencies');
  // git is needed to INSTALL and to UPDATE: Baileys pulls libsignal from a git
  // URL, and `whatsappman update` shells out to `npm install -g`. Missing git
  // therefore doesn't break a running install — it breaks the next update, with
  // a bare "npm error syscall spawn git". Say so here, before that happens.
  const gitVersion = versionOf('git');
  fact(gitVersion ? gitVersion : 'git: NOT FOUND', Boolean(gitVersion));
  if (!gitVersion) {
    bad();
    missing.push('git');
    row('needed by `whatsappman update` (npm fetches libsignal over git)');
  }
  const npmVersion = versionOf('npm');
  fact(npmVersion ? `npm ${npmVersion}` : 'npm: NOT FOUND', Boolean(npmVersion));
  if (!npmVersion) {
    bad();
    missing.push('npm');
  }

  section('config');
  const dirMode = modeOf(baseDir());
  if (dirMode === null) {
    attention(`config dir not created yet (${baseDir()}) — run: whatsappman init`);
  } else {
    // Wrong perms IS a real problem (creds live here); flag it.
    fact(`config dir ${baseDir()} (${dirMode.toString(8)})`, dirMode === 0o700);
    if (dirMode !== 0o700) bad();
  }

  section('daemon');
  const alive = isDaemonAlive();
  const reachable = alive && (await ping());
  if (reachable) {
    fact('running + reachable', true);
    if (process.platform !== 'win32') {
      const sockMode = modeOf(socketPath());
      const tokMode = modeOf(tokenPath());
      if (sockMode !== null) {
        fact(`socket perms ${sockMode.toString(8)}`, sockMode === 0o600);
        if (sockMode !== 0o600) bad();
      }
      if (tokMode !== null) {
        fact(`token perms ${tokMode.toString(8)}`, tokMode === 0o600);
        if (tokMode !== 0o600) bad();
      }
    }
  } else {
    attention('not running — run: whatsappman start');
  }

  section('autostart');
  fact(`mechanism: ${detectMechanism()}`, true);
  if (isInstalled()) {
    fact('OS autostart installed', true);
    // "Installed" only means the OS job exists. The job runs a launcher that
    // hardcodes an ABSOLUTE path to dist/index.js, baked in at install time —
    // so a rename, a reinstall under a different scope, or a moved checkout
    // leaves a job that exists, reports healthy, and dies at every login with
    // ERR_MODULE_NOT_FOUND. Found exactly that here: a launcher still pointing
    // at the retired @indianic scope, so the daemon survived only because
    // manual starts fall back to a detached spawn. Reboot recovery was gone and
    // nothing said so.
    const target = launcherTarget();
    if (target === null) {
      attention(`could not read the launcher at ${launcherPath()} — re-run: whatsappman daemon install`);
    } else if (!fs.existsSync(target)) {
      fact(`launcher target missing: ${target}`, false);
      bad();
      row('the daemon will NOT start at login — run: whatsappman daemon install');
    } else {
      fact('launcher target resolves', true);
    }
  } else attention('not installed — run: whatsappman init');

  if (reachable) {
    section('numbers');
    try {
      const { sessions } = await request<{ sessions: SessionSummary[] }>('list_sessions');
      if (sessions.length === 0) row('none linked');
      for (const s of sessions) fact(`${s.label} — ${s.status}`, s.status === 'connected');
    } catch {
      row('could not list sessions');
    }
  }

  if (missing.length) {
    section('how to fix');
    if (fix) {
      // Printed, never run — see installHint.
      for (const tool of [...new Set(missing)]) row(`${tool}:  ${installHint(tool)}`);
      row('');
      row('re-run `whatsappman doctor` once installed');
    } else {
      row(`missing: ${[...new Set(missing)].join(', ')} — run: whatsappman doctor --fix`);
    }
  }

  outro(ok ? 'doctor: ok' : 'doctor: issues found');
  return ok ? 0 : 1;
}
