import os from 'node:os';
import { readState } from './config/state.js';
import { isDaemonAlive } from './daemon/lock.js';
import { listSessionLabels, readMeta } from './config/sessions.js';
import { readScheduled } from './config/scheduled.js';
import type { SessionStatus } from './config/schema.js';

/**
 * The shape returned by both the `get_status` MCP tool and the `whatsappman
 * status` CLI. The authoritative version is built inside the daemon
 * (buildStatus, below) because only the daemon knows live session state; the
 * CLI falls back to offlineStatus() when the daemon isn't reachable.
 */
export interface SessionSummary {
  label: string;
  phone: string | null;
  status: SessionStatus;
  lastConnectedAt: string | null;
  isDefault: boolean;
}

export interface StatusReport {
  daemon: {
    running: boolean;
    pid: number | null;
    uptimeSec: number | null;
    hostname: string;
    daemonId: string | null;
  };
  defaultSession: string | null;
  sessions: SessionSummary[];
  pendingScheduled: number;
}

/**
 * Built inside the running daemon. `sessions` comes from the live session
 * manager (see daemon/main.ts), so it reflects real-time connection state.
 */
export function buildStatus(
  startedAtMs: number,
  sessions: SessionSummary[],
  pendingScheduled = 0,
): StatusReport {
  const state = readState();
  return {
    daemon: {
      running: true,
      pid: process.pid,
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
      hostname: os.hostname(),
      daemonId: state?.daemonId ?? null,
    },
    defaultSession: state?.defaultSession ?? null,
    sessions,
    pendingScheduled,
  };
}

/** Session summaries from disk (meta.json) — used by the offline CLI view. */
export function diskSessionSummaries(): SessionSummary[] {
  const defaultSession = readState()?.defaultSession ?? null;
  return listSessionLabels().map((label) => {
    const meta = readMeta(label);
    return {
      label,
      phone: meta?.phone ?? null,
      status: meta?.status ?? 'disconnected',
      lastConnectedAt: meta?.lastConnectedAt ?? null,
      isDefault: defaultSession === label,
    };
  });
}

/**
 * Built by the CLI when the daemon is NOT reachable — reflects last-known state
 * from disk plus a liveness check, so `whatsappman status` still says something
 * useful when the daemon is down.
 */
export function offlineStatus(): StatusReport {
  const state = readState();
  const running = isDaemonAlive();
  return {
    daemon: {
      running,
      pid: running ? (state?.pid ?? null) : null,
      uptimeSec: null,
      hostname: os.hostname(),
      daemonId: state?.daemonId ?? null,
    },
    defaultSession: state?.defaultSession ?? null,
    sessions: diskSessionSummaries(),
    pendingScheduled: readScheduled().filter((e) => e.status === 'pending').length,
  };
}
