import fs from 'node:fs';
import { intro, outro, section, row, fail, attention } from './tree.js';
import { baseDir } from '../config/paths.js';
import { stopDaemon } from './daemon-control.js';
import { uninstall as osUninstall } from '../daemon/install.js';
import { confirmDestructive, canPrompt } from './prompts.js';

/**
 * Wipe everything for a clean re-setup: stop the daemon, remove the OS autostart
 * job, and delete the whole config dir (sessions, creds, logs, scheduled queue).
 * Destructive — requires explicit --yes or an interactive "yes".
 */
export async function runReset(yes: boolean): Promise<number> {
  intro('whatsappman — reset');
  attention('this stops the daemon, removes autostart, and DELETES all linked');
  attention('numbers, credentials, logs, and scheduled sends. Cannot be undone.');

  if (!yes) {
    if (!canPrompt('reset needs confirmation — re-run with --yes in a non-interactive shell')) {
      outro('reset');
      return 1;
    }
    if (!(await confirmDestructive('Wipe every number, credential, log and scheduled send?'))) {
      row('aborted — nothing was removed');
      outro('reset');
      return 1;
    }
  }

  await stopDaemon();
  try {
    osUninstall();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(baseDir(), { recursive: true, force: true });
  } catch (err) {
    fail(`could not remove ${baseDir()}: ${String((err as Error)?.message ?? err)}`);
    outro('reset');
    return 1;
  }

  section('reset');
  row(`removed ${baseDir()}`);
  row('run `whatsappman init` to set up again');
  outro('reset');
  return 0;
}
