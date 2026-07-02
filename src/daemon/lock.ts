import fs from 'node:fs';
import { pidPath } from '../config/paths.js';

/** Is a process with this pid currently alive? (signal 0 = existence check) */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the recorded daemon pid, or null if no/invalid pidfile. */
export function readPid(): number | null {
  try {
    const raw = fs.readFileSync(pidPath(), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is the daemon (per the pidfile) currently running? */
export function isDaemonAlive(): boolean {
  const pid = readPid();
  return pid !== null && isPidAlive(pid);
}

/**
 * Acquire the single-instance lock. Returns false if a live daemon already
 * holds it. A stale pidfile (process dead) is reclaimed. Writing the pidfile
 * itself is the lock — combined with the liveness check this prevents two
 * daemons racing for the same socket.
 */
export function acquireLock(): boolean {
  if (isDaemonAlive()) return false;
  fs.writeFileSync(pidPath(), String(process.pid), { mode: 0o600 });
  return true;
}

/** Release the lock only if we still own it (avoid clobbering a successor's pidfile). */
export function releaseLock(): void {
  const pid = readPid();
  if (pid === process.pid) {
    try {
      fs.rmSync(pidPath(), { force: true });
    } catch {
      // best-effort
    }
  }
}
