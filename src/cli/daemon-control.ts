import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBaseDir, logsDir } from '../config/paths.js';
import { isDaemonAlive, readPid, isPidAlive } from '../daemon/lock.js';
import { ping } from '../ipc/client.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Absolute path to the built entrypoint (dist/index.js) for spawning the daemon. */
function entrypoint(): string {
  // this file compiles to dist/cli/daemon-control.js → entry is ../index.js
  return fileURLToPath(new URL('../index.js', import.meta.url));
}

/**
 * Start the daemon as a detached background process. In Phase 1 this is a plain
 * detached spawn; Phase 5 adds the launchd/systemd/Task-Scheduler jobs that run
 * it at login. Returns true if the daemon is confirmed up.
 */
export async function startDaemon(): Promise<boolean> {
  ensureBaseDir();
  if (isDaemonAlive()) return true;

  const outFd = fs.openSync(path.join(logsDir(), 'daemon.out.log'), 'a', 0o600);
  const errFd = fs.openSync(path.join(logsDir(), 'daemon.err.log'), 'a', 0o600);

  const child = spawn(process.execPath, [entrypoint(), 'daemon', 'start'], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  // Confirm it actually came up (socket listening) within a few seconds.
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (await ping()) return true;
  }
  return isDaemonAlive();
}

/** Stop the daemon with a clean SIGTERM and wait for it to exit. */
export async function stopDaemon(): Promise<'stopped' | 'not_running'> {
  const pid = readPid();
  if (pid === null || !isPidAlive(pid)) return 'not_running';

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'not_running';
  }

  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (!isPidAlive(pid)) return 'stopped';
  }
  return 'stopped'; // best-effort; it received SIGTERM
}

export async function restartDaemon(): Promise<boolean> {
  await stopDaemon();
  return startDaemon();
}
