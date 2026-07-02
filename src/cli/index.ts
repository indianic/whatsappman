import { intro, outro, section, row, fact, fail, attention } from './tree.js';
import { renderStatus, renderNumbers } from './render-status.js';
import { startDaemon, stopDaemon, restartDaemon } from './daemon-control.js';
import { runLink, runRelink } from './link.js';
import { runSend, runSendMedia, runSendBulk } from './send.js';
import { runReconnect, runDisconnect, runDelete, runStatusOne } from './sessions.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { runRegister } from './register.js';
import { runSettings } from './settings.js';
import { runRecent } from './recent.js';
import { runReset } from './reset.js';
import { install as osInstall, uninstall as osUninstall, planInstall } from '../daemon/install.js';
import { request } from '../ipc/client.js';
import { offlineStatus, diskSessionSummaries, type StatusReport } from '../status.js';
import type { SessionSummary } from '../status.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';
import { getVersion } from '../version.js';

const COMMANDS = [
  'init',
  'doctor',
  'register',
  'daemon',
  'status',
  'start',
  'stop',
  'restart',
  'link',
  'relink',
  'reconnect',
  'disconnect',
  'delete',
  'numbers',
  'default',
  'send',
  'send-bulk',
  'scheduled',
  'recent',
  'settings',
  'reset',
  'help',
  'examples',
  'version',
];

function hasFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** Pull a `--flag value` out of an args array, returning the value (or undefined). */
function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

async function runDaemonSub(args: string[]): Promise<number> {
  const sub = args[1];
  switch (sub) {
    case 'install': {
      if (hasFlag(args, '--print')) {
        const plan = planInstall();
        intro('whatsappman — daemon install (dry run)');
        section('plan');
        row(`mechanism : ${plan.mechanism}`);
        row(`instance  : ${plan.instanceId}`);
        row(`launcher  : ${plan.launcherPath}`);
        if (plan.jobFile) row(`job file  : ${plan.jobFile}`);
        outro('would write the above — run without --print to apply');
        if (plan.jobContent) {
          process.stdout.write(`\n--- ${plan.jobFile} ---\n${plan.jobContent}\n`);
        }
        process.stdout.write(`--- ${plan.launcherPath} ---\n${plan.launcherContent}\n`);
        return 0;
      }
      intro('whatsappman — daemon install');
      try {
        const r = osInstall();
        section('installed');
        fact(`${r.mechanism}: ${r.note}`, true);
        outro('daemon install');
        return 0;
      } catch (err) {
        fail(String((err as Error)?.message ?? err));
        outro('daemon install');
        return 1;
      }
    }
    case 'uninstall': {
      intro('whatsappman — daemon uninstall');
      const r = osUninstall();
      section('uninstalled');
      row(`removed ${r.mechanism} autostart (sessions kept)`);
      outro('daemon uninstall');
      return 0;
    }
    case 'status':
      await runStatus();
      return 0;
    default:
      intro('whatsappman — daemon');
      fail('usage: whatsappman daemon install [--print] | uninstall | status');
      outro('daemon');
      return 1;
  }
}

interface ScheduledItem {
  scheduledId: string;
  from: string;
  toName: string;
  kind: string;
  fireAt: string;
  status: string;
}

async function runScheduled(args: string[]): Promise<number> {
  const sub = args[1];
  if (sub === 'cancel') {
    const id = args[2];
    intro('whatsappman — scheduled cancel');
    if (!id) {
      fail('usage: whatsappman scheduled cancel <id>');
      outro('scheduled');
      return 1;
    }
    try {
      await request('cancel_scheduled', { scheduledId: id });
      section('cancelled');
      row(id);
      outro('scheduled');
      return 0;
    } catch (err) {
      if (err instanceof WhatsAppManError) {
        fail(`${err.code}: ${err.message}`);
      } else throw err;
      outro('scheduled');
      return 1;
    }
  }

  // default: list
  intro('whatsappman — scheduled');
  try {
    const { scheduled } = await request<{ scheduled: ScheduledItem[] }>('list_scheduled');
    section('scheduled');
    if (scheduled.length === 0) row('none');
    for (const s of scheduled) {
      row(`${s.status.padEnd(9)} ${s.fireAt}  →  ${s.toName} (${s.kind})  [${s.scheduledId.slice(0, 8)}]`);
    }
    outro('scheduled');
    return 0;
  } catch (err) {
    if (err instanceof WhatsAppManError && err.code === ErrorCode.DAEMON_DOWN) {
      fail('daemon not running — run: whatsappman start');
    } else throw err;
    outro('scheduled');
    return 1;
  }
}

async function runNumbers(): Promise<void> {
  try {
    const res = await request<{ sessions: SessionSummary[] }>('list_sessions');
    renderNumbers(res.sessions);
  } catch (err) {
    if (err instanceof WhatsAppManError && err.code === ErrorCode.DAEMON_DOWN) {
      renderNumbers(diskSessionSummaries());
    } else {
      throw err;
    }
  }
}

async function runStatus(): Promise<void> {
  try {
    const report = await request<StatusReport>('status');
    renderStatus(report);
  } catch (err) {
    if (err instanceof WhatsAppManError && err.code === ErrorCode.DAEMON_DOWN) {
      // Daemon not reachable → render last-known/offline view instead of erroring.
      renderStatus(offlineStatus());
    } else {
      throw err;
    }
  }
}

function printHelp(): void {
  intro('whatsappman — commands');
  section('setup');
  row('init             install daemon + link a number + register (one-shot)');
  row('doctor           environment + daemon pre-flight checks');
  row('register [--write]   print/write the MCP config for your AI tools');
  section('daemon');
  row('daemon install [--print] / uninstall   OS autostart (launchd/systemd/…)');
  row('start            start the always-on daemon');
  row('stop             stop the daemon (clean)');
  row('restart          restart the daemon');
  row('status           daemon + linked-number status');
  section('numbers');
  row('link [--label n]     link a WhatsApp number (scan a QR)');
  row('relink <label>       re-pair an expired number (fresh QR)');
  row('reconnect <label>    reconnect a dropped session');
  row('disconnect <label>   drop the socket, keep creds');
  row('delete <label>       permanently remove a number (--yes)');
  row('numbers              list linked numbers + status');
  row('status <label>       detail for one number');
  row('default <label>      set the default number for sends');
  section('send');
  row('send <to> <text> [--from <label>]');
  row('send <to> --kind image|document --path <file> [--caption c]');
  row('send <to> --kind location --lat <n> --lng <n> [--name p]');
  row('send <to> --kind contact --contact-name n --contact-phone p');
  row('send-bulk <text> --to <a,b,c> [--from <label>]');
  section('scheduled');
  row('scheduled            list scheduled sends');
  row('scheduled cancel <id>  cancel a pending scheduled send');
  section('history & settings');
  row('recent [--limit N] [--from label]   recent send history');
  row('settings get | set <key> <value>    view/change settings');
  row('reset [--yes]        wipe everything for a clean re-setup');
  section('general');
  row('help             this list');
  row('examples         setup + usage examples');
  row('version          print version');
  outro('help');
}

function printExamples(): void {
  intro('whatsappman — examples');
  section('one-time setup (terminal)');
  row('whatsappman start        # bring the daemon up');
  row('whatsappman status       # confirm it is running');
  section('from your AI tool (later phases)');
  row('"whatsappman, send \'on my way\' to Kalpesh"');
  outro('examples');
}

function suggest(cmd: string): string | null {
  // trivial nearest-command hint (prefix / substring match)
  const hit = COMMANDS.find((c) => c.startsWith(cmd) || cmd.startsWith(c));
  return hit ?? null;
}

/** Turn literal `\n` / `\t` (which a shell can't easily embed) into real chars,
 *  so `whatsappman send x "line1\nline2"` produces a two-line WhatsApp message. */
function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/** CLI entrypoint. Returns the process exit code. */
export async function cliMain(args: string[]): Promise<number> {
  const cmd = args[0];

  switch (cmd) {
    case 'init': {
      const label = takeFlag(args, '--label');
      const skipReg = hasFlag(args, '--no-register');
      return runInit(label, skipReg);
    }

    case 'doctor':
      return runDoctor();

    case 'register':
      return runRegister(hasFlag(args, '--write'));

    case 'daemon':
      return runDaemonSub(args);

    case 'scheduled':
      return runScheduled(args);

    case 'recent': {
      const limit = takeFlag(args, '--limit');
      const from = takeFlag(args, '--from');
      return runRecent(limit != null ? Number(limit) : 20, from);
    }

    case 'settings':
      return runSettings(args);

    case 'reset':
      return runReset(hasFlag(args, '--yes'));

    case 'status':
      if (args[1]) return runStatusOne(args[1]);
      await runStatus();
      return 0;

    case 'link': {
      const label = takeFlag(args, '--label') ?? args[1];
      return runLink(label);
    }

    case 'relink':
      return runRelink(args[1]);

    case 'reconnect':
      return runReconnect(args[1]);

    case 'disconnect':
      return runDisconnect(args[1]);

    case 'delete': {
      const yes = hasFlag(args, '--yes');
      return runDelete(args[1], yes);
    }

    case 'numbers':
    case 'list':
      await runNumbers();
      return 0;

    case 'default': {
      const label = args[1];
      intro('whatsappman — default');
      if (!label) {
        fail('usage: whatsappman default <label>');
        outro('default');
        return 1;
      }
      try {
        const res = await request<{ defaultSession: string }>('set_default', { label });
        section('default');
        row(`default number set to "${res.defaultSession}"`);
        outro('default');
        return 0;
      } catch (err) {
        if (err instanceof WhatsAppManError) {
          fail(`${err.code}: ${err.message}`);
          for (const step of err.nextSteps ?? []) row(step);
        } else {
          throw err;
        }
        outro('default');
        return 1;
      }
    }

    case 'send': {
      const from = takeFlag(args, '--from');
      const kind = takeFlag(args, '--kind');
      const path = takeFlag(args, '--path');
      const caption = takeFlag(args, '--caption');
      const name = takeFlag(args, '--name');
      const lat = takeFlag(args, '--lat');
      const lng = takeFlag(args, '--lng');
      const contactName = takeFlag(args, '--contact-name');
      const contactPhone = takeFlag(args, '--contact-phone');
      const raw = hasFlag(args, '--raw'); // send verbatim (skip Markdown→WhatsApp)
      hasFlag(args, '--yes'); // accept + consume so it never leaks into the message
      const to = args[1];

      if (kind && kind !== 'text') {
        if (!to) {
          intro('whatsappman — send');
          fail('usage: whatsappman send <to> --kind image|document|location|contact ...');
          outro('send');
          return 1;
        }
        return runSendMedia({
          from,
          to,
          kind: kind as 'image' | 'document' | 'location' | 'contact',
          path,
          caption: caption != null ? unescape(caption) : (args.slice(2).join(' ') ? unescape(args.slice(2).join(' ')) : undefined),
          latitude: lat != null ? Number(lat) : undefined,
          longitude: lng != null ? Number(lng) : undefined,
          name,
          contactName,
          contactPhone,
          raw,
        });
      }

      const text = unescape(args.slice(2).join(' '));
      if (!to || !text) {
        intro('whatsappman — send');
        fail('usage: whatsappman send <to> <text> [--from <label>] [--raw]');
        outro('send');
        return 1;
      }
      return runSend(to, text, from, raw);
    }

    case 'send-bulk': {
      const from = takeFlag(args, '--from');
      const toCsv = takeFlag(args, '--to');
      const raw = hasFlag(args, '--raw');
      hasFlag(args, '--yes');
      const text = unescape(args.slice(1).join(' '));
      if (!toCsv || !text) {
        intro('whatsappman — send-bulk');
        fail('usage: whatsappman send-bulk <text> --to <comma,separated,recipients> [--from <label>]');
        outro('send-bulk');
        return 1;
      }
      const recipients = toCsv.split(',').map((r) => r.trim()).filter(Boolean);
      return runSendBulk(recipients, text, from, raw);
    }

    case 'start': {
      const ok = await startDaemon();
      intro('whatsappman — start');
      if (ok) {
        section('daemon');
        row('started');
      } else {
        fail('failed to start — see ~/.whatsappman/logs/daemon.err.log');
      }
      outro('start');
      return ok ? 0 : 1;
    }

    case 'stop': {
      const res = await stopDaemon();
      intro('whatsappman — stop');
      section('daemon');
      row(res === 'stopped' ? 'stopped' : 'was not running');
      outro('stop');
      return 0;
    }

    case 'restart': {
      const ok = await restartDaemon();
      intro('whatsappman — restart');
      section('daemon');
      if (ok) {
        row('restarted');
      } else {
        fail('failed to restart — see ~/.whatsappman/logs/daemon.err.log');
      }
      outro('restart');
      return ok ? 0 : 1;
    }

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;

    case 'examples':
      printExamples();
      return 0;

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`whatsappman ${getVersion()}\n`);
      return 0;

    default: {
      intro('whatsappman');
      fail(`unknown command: ${cmd}`);
      const s = suggest(cmd);
      if (s) attention(`did you mean "${s}"?`);
      row('run "whatsappman help" for the command list');
      outro('error');
      return 1;
    }
  }
}
