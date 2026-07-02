import fs from 'node:fs';
import net from 'node:net';
import { socketPath } from '../config/paths.js';

/**
 * Platform transport. On POSIX the endpoint is a Unix domain socket file; on
 * Windows it's a named pipe. `net` handles both with the same path string, so
 * only stale-file cleanup and permission tightening differ by platform.
 */

/**
 * Remove a leftover socket file (POSIX) before binding. Safe because the daemon
 * only reaches here after acquireLock() has already confirmed no *other* live
 * daemon holds the single-instance lock (see daemon/lock.ts + main.ts) — so any
 * socket file present is necessarily stale (from a crashed predecessor). We do
 * NOT re-check isDaemonAlive() here: acquireLock has just written our own pid,
 * so that would falsely report "alive" and skip cleaning a real stale socket.
 */
export function removeStaleSocket(): void {
  if (process.platform === 'win32') return; // named pipes aren't filesystem entries
  const p = socketPath();
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {
    // best-effort
  }
}

/** Tighten the socket file to 0600 after the server binds it (POSIX only). */
export function secureSocketFile(): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(socketPath(), 0o600);
  } catch {
    // best-effort
  }
}

/** Open a client connection to the daemon endpoint. */
export function connect(): net.Socket {
  return net.connect(socketPath());
}
