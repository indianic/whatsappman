import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { intro, outro, section, row, fact, attention, fail } from './tree.js';
import { getVersion } from '../version.js';
import { isNewerVersion } from './update-notifier.js';
import { isDaemonAlive } from '../daemon/lock.js';
import { restartDaemon } from './daemon-control.js';

const execFileAsync = promisify(execFile);
const PKG = '@indianic/whatsappman';

/**
 * `whatsappman update` (alias `upgrade`) — check npm.indianic.in for a newer
 * version and update the global install in place. Relies on ~/.npmrc's
 * `@indianic:registry` scope routing (no --registry flag), same as every other
 * install path. If the daemon is running it's restarted afterward so it loads
 * the new code (a running daemon keeps executing the OLD dist until it does).
 */
export async function runUpdate(): Promise<number> {
  intro('whatsappman — update');
  const current = getVersion();

  let latest: string;
  try {
    const { stdout } = await execFileAsync('npm', ['view', PKG, 'version']);
    latest = stdout.trim().split('\n').pop()!.trim();
  } catch (err) {
    fail(`couldn't reach the registry: ${err instanceof Error ? err.message : String(err)}`);
    outro('update');
    return 1;
  }

  section('versions');
  row(`installed   ${current}`);
  row(`latest      ${latest}`);

  // Only upgrade when the registry is strictly newer — so a dev build that's
  // ahead of the published version never gets "updated" backwards.
  if (!isNewerVersion(latest, current)) {
    outro(`already up to date (${current})`);
    return 0;
  }

  try {
    await execFileAsync('npm', ['install', '-g', `${PKG}@${latest}`]);
  } catch (err) {
    fail(`npm install -g failed: ${err instanceof Error ? err.message : String(err)}`);
    row(`try manually: npm install -g ${PKG}@latest`);
    outro('update');
    return 1;
  }

  section('updated');
  fact(`${current} → ${latest}`, true);

  // The running daemon still holds the old code — restart it to pick up the new
  // build (this briefly drops + auto-reconnects each WhatsApp session).
  if (isDaemonAlive()) {
    row('restarting daemon to load the new version…');
    const ok = await restartDaemon();
    if (ok) row('daemon restarted');
    else attention('daemon restart failed — run: whatsappman restart');
  }
  attention('restart any AI tools (Claude Code, Cursor…) so their MCP server reloads');
  outro('update');
  return 0;
}
