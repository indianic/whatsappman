import { intro, outro, section, row, fact, fail, attention } from './tree.js';
import { renderStatus, renderNumbers } from './render-status.js';
import { startDaemon, stopDaemon, restartDaemon } from './daemon-control.js';
import { runLink, runRelink } from './link.js';
import { runSend, runSendMedia, runSendBulk, runPresence, runMe } from './send.js';
import { runSummary } from './summary.js';
import { runCommand } from './run.js';
import { selectOne, canPrompt } from './prompts.js';
import { runReconnect, runDisconnect, runDelete, runStatusOne, runDefault, runRename } from './sessions.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { runRegister } from './register.js';
import { runSettings } from './settings.js';
import { runRecent } from './recent.js';
import { runReset } from './reset.js';
import { runUpdate } from './update.js';
import { maybeNotifyUpdate, refreshUpdateCache, REFRESH_COMMAND } from './update-notifier.js';
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
  'rename',
  'numbers',
  'default',
  'send',
  'send-bulk',
  'presence',
  'me',
  'run',
  'summary',
  'scheduled',
  'recent',
  'settings',
  'reset',
  'update',
  'upgrade',
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

/** One pending send as a menu row: when, to whom, what kind. Pure, for tests. */
export function scheduledChoiceLabel(s: ScheduledItem): string {
  return `${s.fireAt}  →  ${s.toName} (${s.kind})`;
}

async function runScheduled(args: string[]): Promise<number> {
  const sub = args[1];
  if (sub === 'cancel') {
    let id = args[2];
    intro('whatsappman — scheduled cancel');
    // No id: pick from what is actually pending. A scheduled id is a UUID —
    // nobody types one from memory, they copy it from a list, so show the list.
    if (!id) {
      if (!canPrompt('usage: whatsappman scheduled cancel <id>')) {
        outro('scheduled');
        return 1;
      }
      try {
        // Fetch every entry, not just pending, so an empty result can explain
        // itself: `whatsappman scheduled` may well have just shown you rows,
        // and "nothing pending" next to them reads like a bug unless we say
        // those rows are already sent and there is nothing left to cancel.
        const { scheduled: all } = await request<{ scheduled: ScheduledItem[] }>('list_scheduled');
        const scheduled = all.filter((s) => s.status === 'pending');
        if (scheduled.length === 0) {
          section('scheduled');
          if (all.length) {
            const done = all.map((s) => s.status).filter((v, i, a) => a.indexOf(v) === i).join('/');
            row(`nothing pending to cancel — all ${all.length} are already ${done}`);
          } else {
            row('nothing scheduled');
          }
          outro('scheduled');
          return 0;
        }
        const picked = await selectOne(
          'Cancel which scheduled send?',
          scheduled.map((s) => ({ value: s.scheduledId, label: scheduledChoiceLabel(s) })),
        );
        if (!picked) {
          outro('scheduled');
          return 1;
        }
        id = picked;
      } catch (err) {
        if (err instanceof WhatsAppManError) fail(`${err.code}: ${err.message}`);
        else throw err;
        outro('scheduled');
        return 1;
      }
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
  row('register [--write]   print/write MCP config (--tools claude,cursor,gemini,windsurf,codex)');
  section('daemon');
  row('daemon install [--print] / uninstall   OS autostart (launchd/systemd/…)');
  row('start            start the always-on daemon');
  row('stop             stop the daemon (clean)');
  row('restart          restart the daemon');
  row('status           daemon + linked-number status');
  section('numbers');
  row('link [--label n]     link a number (scan a QR); pass --label to add MORE');
  row('     [--image]       open the QR as an image instead of drawing it in the terminal');
  row('relink [<label>]     re-pair an expired number (fresh QR); --image works here too');
  row('reconnect [<label>]  reconnect a dropped session');
  row('disconnect [<label>] drop the socket, keep creds');
  row('rename [<label> <new>]  rename a number (keeps creds + history)');
  row('delete [<label>]     permanently remove a number (--yes)');
  row('numbers              list linked numbers + status');
  row('status [<label>]     detail for one number');
  row('default [<label>]    set the default number for sends');
  row('(omit <label> on any of these to pick from a list instead of typing it)');
  section('send');
  row('send <to> <text> [--from <label>]');
  row('send <to> --kind image|document --path <file> [--caption c]');
  row('send <to> --kind location --lat <n> --lng <n> [--name p]');
  row('send <to> --kind contact --contact-name n --contact-phone p');
  row('send-bulk <text> --to <a,b,c> [--from <label>]');
  row('presence <to> <typing|online|offline|recording|paused> [--from label]');
  row('me <text>            message yourself (note-to-self inbox)');
  section('daily');
  row('run [--to r] [--on-fail] -- <command>   run it, then WhatsApp how it went');
  row('summary [--to r]     digest of your AI coding sessions (this project)');
  row('        [--all] [--project p] [--days N] [--last N]   widen the digest');
  section('scheduled');
  row('scheduled            list scheduled sends');
  row('scheduled cancel <id>  cancel a pending scheduled send');
  section('history & settings');
  row('recent [--limit N] [--from label]   recent send history');
  row('settings get | set <key> <value>    view/change settings');
  row('update (upgrade)     update to the latest published version');
  row('reset [--yes]        wipe everything for a clean re-setup');
  section('general');
  row('help             this list');
  row('examples         setup + usage examples');
  row('version          print version');
  section('prompts');
  row('any command that needs a value will ask for it — arrow keys to choose,');
  row('Enter to confirm, and Esc (or Ctrl-C) to cancel and change nothing.');
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

  // Hidden: the detached background refresh of the update-check cache.
  if (cmd === REFRESH_COMMAND) {
    await refreshUpdateCache();
    return 0;
  }

  // Passive "update available" notice before the command's own output.
  maybeNotifyUpdate(cmd);

  switch (cmd) {
    case 'init': {
      const label = takeFlag(args, '--label');
      const skipReg = hasFlag(args, '--no-register');
      return runInit(label, skipReg);
    }

    case 'doctor':
      return runDoctor();

    case 'register': {
      const tools = takeFlag(args, '--tools');
      const scope = hasFlag(args, '--project') ? 'project' : 'global';
      return runRegister(hasFlag(args, '--write'), tools, scope);
    }

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

    case 'update':
    case 'upgrade':
      return runUpdate();

    case 'status':
      if (args[1]) return runStatusOne(args[1]);
      await runStatus();
      return 0;

    case 'link': {
      const asImage = hasFlag(args, '--image');
      const label = takeFlag(args, '--label') ?? (args[1] === '--image' ? undefined : args[1]);
      return runLink(label, asImage);
    }

    case 'relink':
      return runRelink(args[1], hasFlag(args, '--image'));

    case 'reconnect':
      return runReconnect(args[1]);

    case 'disconnect':
      return runDisconnect(args[1]);

    case 'delete': {
      const yes = hasFlag(args, '--yes');
      return runDelete(args[1], yes);
    }

    case 'rename':
      return runRename(args[1], args[2]);

    case 'numbers':
    case 'list':
      await runNumbers();
      return 0;

    case 'default':
      return runDefault(args[1]);

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

    case 'me': {
      const from = takeFlag(args, '--from');
      const text = unescape(args.slice(1).join(' '));
      if (!text) {
        intro('whatsappman — me');
        fail('usage: whatsappman me <text> [--from <label>]');
        outro('me');
        return 1;
      }
      return runMe(text, from);
    }

    case 'run': {
      const to = takeFlag(args, '--to');
      const from = takeFlag(args, '--from');
      const quiet = hasFlag(args, '--quiet');
      const onFail = hasFlag(args, '--on-fail');
      // Everything after `--` is the command; without it, the rest of argv is.
      const sep = args.indexOf('--');
      const cmd = sep === -1 ? args.slice(1) : args.slice(sep + 1);
      return runCommand(cmd, { to, from, quiet, onFail });
    }

    case 'summary': {
      const to = takeFlag(args, '--to');
      const from = takeFlag(args, '--from');
      const project = takeFlag(args, '--project');
      const last = takeFlag(args, '--last');
      const days = takeFlag(args, '--days');
      const max = takeFlag(args, '--max');
      const all = hasFlag(args, '--all');
      return runSummary({
        all,
        project,
        to,
        from,
        last: last != null ? Number(last) : undefined,
        days: days != null ? Number(days) : undefined,
        max: max != null ? Number(max) : undefined,
      });
    }

    case 'presence': {
      const from = takeFlag(args, '--from');
      const to = args[1];
      let kind = args[2];
      if (!to) {
        intro('whatsappman — presence');
        fail('usage: whatsappman presence <to> <typing|online|offline|recording|paused> [--from <label>]');
        outro('presence');
        return 1;
      }
      // The recipient must be explicit (we won't guess who to signal), but the
      // state is a closed set — offer it rather than make you recall the words.
      if (!kind) {
        intro('whatsappman — presence');
        if (!canPrompt('usage: whatsappman presence <to> <typing|online|offline|recording|paused>')) {
          outro('presence');
          return 1;
        }
        const picked = await selectOne('Which presence?', [
          { value: 'typing', label: 'typing', hint: 'shows "typing…"' },
          { value: 'recording', label: 'recording', hint: 'shows "recording audio…"' },
          { value: 'online', label: 'online', hint: 'appear available' },
          { value: 'offline', label: 'offline', hint: 'appear unavailable' },
          { value: 'paused', label: 'paused', hint: 'stop the indicator' },
        ]);
        if (!picked) {
          outro('presence');
          return 1;
        }
        kind = picked;
        return runPresence(to, kind, from, true); // intro already printed above
      }
      return runPresence(to, kind, from);
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
