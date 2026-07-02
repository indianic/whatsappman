import { intro, outro, section, row, fail, attention } from './tree.js';
import { renderStatus, renderNumbers } from './render-status.js';
import { startDaemon, stopDaemon, restartDaemon } from './daemon-control.js';
import { runLink } from './link.js';
import { runSend } from './send.js';
import { request } from '../ipc/client.js';
import { offlineStatus, diskSessionSummaries, type StatusReport } from '../status.js';
import type { SessionSummary } from '../status.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';
import { getVersion } from '../version.js';

const COMMANDS = [
  'status',
  'start',
  'stop',
  'restart',
  'link',
  'numbers',
  'default',
  'send',
  'help',
  'examples',
  'version',
];

/** Pull a `--flag value` out of an args array, returning the value (or undefined). */
function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
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
  section('daemon');
  row('start            start the always-on daemon');
  row('stop             stop the daemon (clean)');
  row('restart          restart the daemon');
  row('status           daemon + linked-number status');
  section('numbers');
  row('link [--label n] link a WhatsApp number (scan a QR)');
  row('numbers          list linked numbers + status');
  row('default <label>  set the default number for sends');
  section('send');
  row('send <to> <text> [--from <label>]   send a text message');
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

/** CLI entrypoint. Returns the process exit code. */
export async function cliMain(args: string[]): Promise<number> {
  const cmd = args[0];

  switch (cmd) {
    case 'status':
      await runStatus();
      return 0;

    case 'link': {
      const label = takeFlag(args, '--label') ?? args[1];
      return runLink(label);
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
      const to = args[1];
      const text = args.slice(2).join(' ');
      if (!to || !text) {
        intro('whatsappman — send');
        fail('usage: whatsappman send <to> <text> [--from <label>]');
        outro('send');
        return 1;
      }
      return runSend(to, text, from);
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
