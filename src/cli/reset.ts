import fs from 'node:fs';
import readline from 'node:readline';
import { intro, outro, section, row, fail, attention } from './tree.js';
import { baseDir } from '../config/paths.js';
import { stopDaemon } from './daemon-control.js';
import { uninstall as osUninstall } from '../daemon/install.js';
import { isInteractiveTerminal } from './interactive.js';

async function confirmYes(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(promptText, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

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
    if (!isInteractiveTerminal()) {
      fail('reset needs confirmation — re-run with --yes in a non-interactive shell.');
      outro('reset');
      return 1;
    }
    const ok = await confirmYes('Type "yes" to wipe everything: ');
    if (!ok) {
      row('aborted');
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
