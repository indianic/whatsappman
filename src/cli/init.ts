import { intro, outro, section, row, fact, attention, fail } from './tree.js';
import { ensureBaseDir } from '../config/paths.js';
import { install } from '../daemon/install.js';
import { startDaemon } from './daemon-control.js';
import { runLink } from './link.js';
import { runRegister } from './register.js';
import { requireTty } from './interactive.js';

/**
 * First-run wizard: create the config dir, install the OS autostart job, start
 * the daemon, link the first number by QR, and print the MCP registration. The
 * recommended one-command setup. Idempotent-ish (install unloads+reloads).
 */
export async function runInit(label: string | undefined, skipRegister: boolean): Promise<number> {
  // init pairs a number via QR — a real terminal is required.
  if (!requireTty('whatsappman init')) return 1;

  intro('whatsappman — init');
  ensureBaseDir();

  section('1/4 · install autostart daemon');
  try {
    const res = install();
    fact(`${res.mechanism}: ${res.note}`, true);
  } catch (err) {
    fail(`install failed: ${String((err as Error)?.message ?? err)}`);
    attention('you can still run the daemon manually with `whatsappman start`');
  }

  section('2/4 · start daemon');
  const up = await startDaemon();
  fact(up ? 'daemon running' : 'daemon not running — see ~/.whatsappman/logs/daemon.err.log', up);
  if (!up) {
    outro('init');
    return 1;
  }

  section('3/4 · link your first number');
  row('a QR will render below — scan it in WhatsApp → Linked Devices');
  const linkCode = await runLink(label ?? 'default');

  if (!skipRegister) {
    section('4/4 · register with your AI tools');
    runRegister(false);
  }

  outro(linkCode === 0 ? 'init: done' : 'init: daemon ready, linking incomplete');
  return linkCode;
}
