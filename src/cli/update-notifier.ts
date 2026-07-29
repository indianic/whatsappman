import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { baseDir } from '../config/paths.js';
import { getVersion, getPackageName } from '../version.js';

/**
 * Passive "update available" notifier (ported from mailman) — every
 * interactive command prints a short notice BEFORE its own output when a newer
 * version is known, without ever blocking on the network.
 *
 * Stays instant via a cached latest-version (`update-check.json` in the config
 * dir). When the cache is missing/stale, a detached, unref'd background process
 * (`whatsappman __refresh-update-cache`) refreshes it and exits — the current
 * command never waits. First run seeds the cache silently; later runs show the
 * notice. This only *tells*; `whatsappman update` does the actual upgrade.
 *
 * Never breaks the command it precedes: every path swallows its errors.
 */

const execFileAsync = promisify(execFile);
const PKG = getPackageName();
const TTL_MS = 24 * 60 * 60 * 1000; // check the registry at most once a day
/** Hidden subcommand the detached refresh re-enters through (not in COMMANDS). */
export const REFRESH_COMMAND = '__refresh-update-cache';

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return path.join(baseDir(), 'update-check.json');
}

function readCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<UpdateCache>;
    if (typeof parsed.latest === 'string' && typeof parsed.checkedAt === 'number') {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    // missing/corrupt cache → treated as "no data", triggers a refresh
  }
  return null;
}

/**
 * True when `latest` is strictly newer than `current` — numeric per-part
 * compare of x.y.z (a trailing `-tag` is dropped so `1.2.3-beta` never reads as
 * newer than `1.2.3`). Exported + reused by `whatsappman update`.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Suppress the notice for non-interactive stdout (MCP stdio, pipes), CI, or opt-out. */
function suppressed(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.CI != null ||
    process.env.NO_UPDATE_NOTIFIER != null ||
    process.env.WHATSAPPMAN_NO_UPDATE_NOTIFIER != null
  );
}

function renderNotice(current: string, latest: string): void {
  const bar = pc.gray('│');
  process.stdout.write(`${pc.yellow('▲')}  Update available: ${pc.dim(current)} → ${pc.green(latest)}\n`);
  process.stdout.write(`${bar}  Run ${pc.cyan('whatsappman update')} to upgrade.\n`);
  process.stdout.write(`${bar}\n`);
}

/** Spawn the detached background refresh; a failure to spawn is ignored. */
function spawnRefresh(): void {
  try {
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, REFRESH_COMMAND], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // can't spawn (sandboxed / odd PATH) — next run tries again
  }
}

/** Called once per command, before dispatch. */
export function maybeNotifyUpdate(command: string): void {
  try {
    // Commands that report versions themselves or are machine-facing: skip.
    if (command === 'update' || command === 'upgrade' || command === REFRESH_COMMAND) return;
    if (suppressed()) return;

    const current = getVersion();
    const cache = readCache();
    if (cache && isNewerVersion(cache.latest, current)) renderNotice(current, cache.latest);
    if (!cache || Date.now() - cache.checkedAt > TTL_MS) spawnRefresh();
  } catch {
    // a notifier must never break the command it precedes
  }
}

/** Body of the hidden `__refresh-update-cache` subcommand (runs detached). */
export async function refreshUpdateCache(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', PKG, 'version'], { timeout: 15_000 });
    const latest = stdout.trim().split('\n').pop()?.trim();
    if (!latest) return;
    mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify({ latest, checkedAt: Date.now() } satisfies UpdateCache));
  } catch {
    // offline / registry unreachable — leave the old cache in place
  }
}
