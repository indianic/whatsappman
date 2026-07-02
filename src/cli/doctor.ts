import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { intro, outro, section, fact, row, attention } from './tree.js';
import { baseDir, socketPath, tokenPath } from '../config/paths.js';
import { detectMechanism, isInstalled } from '../daemon/install.js';
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

/** Pre-flight environment + daemon checks. Read-only; never mutates anything. */
export async function runDoctor(): Promise<number> {
  intro('whatsappman — doctor');
  let ok = true;
  const bad = () => {
    ok = false;
  };

  section('runtime');
  const major = Number(process.versions.node.split('.')[0]);
  fact(`node ${process.versions.node}`, major >= 18);
  if (major < 18) bad();
  const hasNode = resolvable('node');
  const hasNpx = resolvable('npx');
  fact(`node on PATH: ${hasNode ? 'yes' : 'no'}`, hasNode);
  fact(`npx on PATH: ${hasNpx ? 'yes' : 'no'}`, hasNpx);
  if (!hasNode || !hasNpx) bad();

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
  if (isInstalled()) fact('OS autostart installed', true);
  else attention('not installed — run: whatsappman init');

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

  outro(ok ? 'doctor: ok' : 'doctor: issues found');
  return ok ? 0 : 1;
}
