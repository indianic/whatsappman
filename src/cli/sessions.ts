import { intro, outro, section, row, fact, fail, attention, pad } from './tree.js';
import { askText, confirmDestructive, canPrompt } from './prompts.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import { isInteractiveTerminal } from './interactive.js';
import { pickSession } from './pick.js';
import type { SessionSummary } from '../status.js';

function reportError(err: unknown, label: string): number {
  if (err instanceof WhatsAppManError) {
    fail(`${err.code}: ${err.message}`);
    for (const step of err.nextSteps ?? []) row(step);
  } else {
    fail(String((err as Error)?.message ?? err));
  }
  outro(label);
  return 1;
}

/**
 * Resolve the target label for a label-taking command: use the one typed, else
 * (no label) open the interactive picker over the existing numbers. Returns the
 * chosen label, or null if the user cancelled / there was nothing to pick — in
 * which case the picker has already explained why and the caller should outro.
 * Must be called after intro().
 */
async function resolveLabel(action: string, label: string | undefined): Promise<string | null> {
  if (label) return label;
  return pickSession(action);
}

export async function runReconnect(label: string | undefined): Promise<number> {
  intro('whatsappman — reconnect');
  const lbl = await resolveLabel('reconnect', label);
  if (!lbl) {
    outro('reconnect');
    return 1;
  }
  try {
    const r = await request<{ label: string; status: string }>('reconnect', { label: lbl });
    section('reconnect');
    fact(`"${r.label}" is now ${r.status}`, r.status === 'connected' || r.status === 'connecting');
    outro('reconnect');
    return 0;
  } catch (err) {
    return reportError(err, 'reconnect');
  }
}

export async function runDisconnect(label: string | undefined): Promise<number> {
  intro('whatsappman — disconnect');
  const lbl = await resolveLabel('disconnect', label);
  if (!lbl) {
    outro('disconnect');
    return 1;
  }
  try {
    const r = await request<{ label: string; status: string }>('disconnect', { label: lbl });
    section('disconnect');
    row(`"${r.label}" ${r.status} (creds kept — reconnect anytime)`);
    outro('disconnect');
    return 0;
  } catch (err) {
    return reportError(err, 'disconnect');
  }
}

/** Set the default number used when a send omits `from`. Picks from the list
 *  when no label is given. */
export async function runDefault(label: string | undefined): Promise<number> {
  intro('whatsappman — default');
  // autoSingle: with just one number there is nothing to choose.
  const lbl = label ?? (await pickSession('set as default', { autoSingle: true, command: 'default' }));
  if (!lbl) {
    outro('default');
    return 1;
  }
  try {
    const res = await request<{ defaultSession: string }>('set_default', { label: lbl });
    section('default');
    row(`default number set to "${res.defaultSession}"`);
    outro('default');
    return 0;
  } catch (err) {
    return reportError(err, 'default');
  }
}


/** Rename a number's label (keeps creds + history). Picks the source from the
 *  list when omitted, and prompts for the new name when omitted. */
export async function runRename(oldLabel: string | undefined, newLabel: string | undefined): Promise<number> {
  intro('whatsappman — rename');
  const from = await resolveLabel('rename', oldLabel);
  if (!from) {
    outro('rename');
    return 1;
  }
  let to = newLabel;
  if (!to) {
    if (!canPrompt('no new label given — usage: whatsappman rename <label> <newLabel>')) {
      outro('rename');
      return 1;
    }
    const answer = await askText(`New label for "${from}"`, { placeholder: 'e.g. work' });
    if (!answer) {
      outro('rename');
      return 1;
    }
    to = answer;
  }
  try {
    const r = await request<{ from: string; to: string; status: string }>('rename_session', {
      oldLabel: from,
      newLabel: to,
    });
    section('rename');
    fact(`"${r.from}" → "${r.to}" (${r.status})`, true);
    outro('rename');
    return 0;
  } catch (err) {
    return reportError(err, 'rename');
  }
}

export async function runDelete(label: string | undefined, yes: boolean): Promise<number> {
  intro('whatsappman — delete');
  const lbl = await resolveLabel('delete', label);
  if (!lbl) {
    outro('delete');
    return 1;
  }
  if (!yes) {
    if (!canPrompt('delete needs confirmation — re-run with --yes in a non-interactive shell')) {
      outro('delete');
      return 1;
    }
    attention(`this permanently removes "${lbl}" (creds + history). This cannot be undone.`);
    if (!(await confirmDestructive(`Permanently delete "${lbl}"?`))) {
      row('aborted — nothing was deleted');
      outro('delete');
      return 1;
    }
  }
  try {
    await request('delete_session', { label: lbl });
    section('delete');
    row(`"${lbl}" deleted`);
    outro('delete');
    return 0;
  } catch (err) {
    return reportError(err, 'delete');
  }
}

export async function runStatusOne(label: string): Promise<number> {
  intro(`whatsappman — status "${label}"`);
  try {
    const { sessions } = await request<{ sessions: SessionSummary[] }>('list_sessions');
    const s = sessions.find((x) => x.label === label);
    section('number');
    if (!s) {
      // Don't dead-end on a typo or a label that has since been renamed: say
      // what IS there, so the next command is obvious.
      fail(`no session "${label}"`);
      if (sessions.length) {
        row(`linked numbers: ${sessions.map((x) => x.label).join(', ')}`);
      } else {
        row('no numbers linked yet — run: whatsappman link');
      }
      outro('status');
      return 1;
    }
    row(`${pad('label', 10)} ${s.label}${s.isDefault ? '  (default)' : ''}`);
    row(`${pad('phone', 10)} ${s.phone ?? '—'}`);
    row(`${pad('status', 10)} ${s.status}`);
    row(`${pad('last conn', 10)} ${s.lastConnectedAt ?? '—'}`);
    outro('status');
    return 0;
  } catch (err) {
    return reportError(err, 'status');
  }
}
