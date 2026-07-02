import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * All whatsappman state lives under one global, per-OS-user directory —
 * never project-relative. Resolved from os.homedir(), overridable with
 * WHATSAPPMAN_DIR (used by tests and isolated setups). See docs/PLAN.md.
 */
export function baseDir(): string {
  const override = process.env.WHATSAPPMAN_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.whatsappman');
}

/** Create the config dir (and required subdirs) with 0700 perms if missing. */
export function ensureBaseDir(): string {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is subject to umask and ignored if the dir already exists,
  // so chmod explicitly to guarantee 0700 on every run.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms without POSIX perms (Windows)
  }
  fs.mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  // The socket may live outside the config dir when the natural path would
  // exceed the OS's Unix-socket length limit (see socketPath); ensure its
  // parent dir exists with 0700 perms.
  const sockDir = path.dirname(socketPath());
  if (sockDir !== dir) {
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(sockDir, 0o700);
    } catch {
      /* best-effort */
    }
  }
  return dir;
}

export function statePath(): string {
  return path.join(baseDir(), 'state.json');
}

export function settingsPath(): string {
  return path.join(baseDir(), 'settings.json');
}

export function pidPath(): string {
  return path.join(baseDir(), 'daemon.pid');
}

export function tokenPath(): string {
  return path.join(baseDir(), 'daemon.token');
}

export function scheduledPath(): string {
  return path.join(baseDir(), 'scheduled.json');
}

export function sentLogPath(): string {
  return path.join(baseDir(), 'sent.jsonl');
}

export function logsDir(): string {
  return path.join(baseDir(), 'logs');
}

export function sessionsDir(): string {
  return path.join(baseDir(), 'sessions');
}

/**
 * IPC endpoint. On POSIX it's a Unix domain socket file inside the 0700 config
 * dir (so the filesystem itself restricts connection to the owning user). On
 * Windows there are no Unix sockets, so it's a named pipe (secured with an
 * owner-only DACL at creation time — see docs/SECURITY.md, Phase 5).
 */
export function socketPath(): string {
  if (process.platform === 'win32') {
    // Per-user pipe name to avoid cross-user collision on shared machines.
    const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_-]/g, '');
    return `\\\\.\\pipe\\whatsappman-${user}`;
  }
  const natural = path.join(baseDir(), 'daemon.sock');
  // Unix domain socket paths are capped (~104 chars on macOS, ~108 on Linux).
  // The default ~/.whatsappman/daemon.sock is well under, but a deep homedir or
  // a long WHATSAPPMAN_DIR can overflow → EINVAL on bind. Fall back to a
  // per-config-dir 0700 directory under the OS temp dir, named by a hash of the
  // base dir so it stays stable and collision-free.
  if (natural.length <= 100) return natural;
  const hash = crypto.createHash('sha1').update(baseDir()).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `whatsappman-${hash}`, 'daemon.sock');
}
