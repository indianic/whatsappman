import readline from 'node:readline';
import { intro, outro, section, row, fact, fail, attention, pad } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
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

function requireLabel(cmd: string, label: string | undefined): label is string {
  if (!label) {
    intro(`whatsappman — ${cmd}`);
    fail(`usage: whatsappman ${cmd} <label>`);
    outro(cmd);
    return false;
  }
  return true;
}

export async function runReconnect(label: string | undefined): Promise<number> {
  if (!requireLabel('reconnect', label)) return 1;
  intro(`whatsappman — reconnect "${label}"`);
  try {
    const r = await request<{ label: string; status: string }>('reconnect', { label });
    section('reconnect');
    fact(`"${r.label}" is now ${r.status}`, r.status === 'connected' || r.status === 'connecting');
    outro('reconnect');
    return 0;
  } catch (err) {
    return reportError(err, 'reconnect');
  }
}

export async function runDisconnect(label: string | undefined): Promise<number> {
  if (!requireLabel('disconnect', label)) return 1;
  intro(`whatsappman — disconnect "${label}"`);
  try {
    const r = await request<{ label: string; status: string }>('disconnect', { label });
    section('disconnect');
    row(`"${r.label}" ${r.status} (creds kept — reconnect anytime)`);
    outro('disconnect');
    return 0;
  } catch (err) {
    return reportError(err, 'disconnect');
  }
}

async function confirmYes(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(promptText, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runDelete(label: string | undefined, yes: boolean): Promise<number> {
  if (!requireLabel('delete', label)) return 1;
  intro(`whatsappman — delete "${label}"`);
  if (!yes) {
    attention(`this permanently removes "${label}" (creds + history). This cannot be undone.`);
    const ok = await confirmYes('Type "yes" to confirm: ');
    if (!ok) {
      row('aborted');
      outro('delete');
      return 1;
    }
  }
  try {
    await request('delete_session', { label });
    section('delete');
    row(`"${label}" deleted`);
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
      fail(`no session "${label}"`);
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
