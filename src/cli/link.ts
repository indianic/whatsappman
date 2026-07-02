import QRCode from 'qrcode';
import { intro, outro, section, fact, row, attention, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { startDaemon } from './daemon-control.js';
import { isDaemonAlive } from '../daemon/lock.js';
import { normalizeLabel } from '../config/sessions.js';
import { WhatsAppManError } from '../errors.js';

interface LinkState {
  label: string;
  status: string;
  qr: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 90; // ~3 minutes

async function renderQr(qr: string): Promise<void> {
  const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
  process.stdout.write('\n' + ascii + '\n');
}

/**
 * Link (or relink) a WhatsApp number. Starts the daemon if needed, asks it to
 * begin pairing, renders the QR in the terminal, and polls until the number
 * connects (or the session reports it needs relinking / times out). The actual
 * QR scan is done by the user on their phone.
 */
export async function runLink(rawLabel: string | undefined): Promise<number> {
  const label = normalizeLabel(rawLabel ?? 'default');

  intro(`whatsappman — link "${label}"`);

  if (!isDaemonAlive()) {
    row('starting daemon…');
    const ok = await startDaemon();
    if (!ok) {
      fail('could not start the daemon — see ~/.whatsappman/logs/daemon.err.log');
      outro('link');
      return 1;
    }
  }

  let state: LinkState;
  try {
    state = await request<LinkState>('link', { label });
  } catch (err) {
    return failWith(err);
  }

  if (state.status === 'connected') {
    section('done');
    fact(`"${label}" is already connected`, true);
    outro('link');
    return 0;
  }

  section('scan this QR in WhatsApp → Settings → Linked Devices → Link a Device');
  let lastQr: string | null = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    if (state.qr && state.qr !== lastQr) {
      lastQr = state.qr;
      await renderQr(state.qr);
    }

    if (state.status === 'connected') {
      section('done');
      fact(`"${label}" linked and connected`, true);
      outro('link');
      return 0;
    }
    if (state.status === 'needs_relink' || state.status === 'logged_out') {
      fail(`"${label}" reported ${state.status} — try again`);
      outro('link');
      return 1;
    }

    await sleep(POLL_INTERVAL_MS);
    try {
      state = await request<LinkState>('link_status', { label });
    } catch (err) {
      return failWith(err);
    }
  }

  attention('timed out waiting for the QR to be scanned — run link again to retry');
  outro('link');
  return 1;
}

function failWith(err: unknown): number {
  if (err instanceof WhatsAppManError) {
    fail(`${err.code}: ${err.message}`);
    for (const step of err.nextSteps ?? []) row(step);
  } else {
    fail(String((err as Error)?.message ?? err));
  }
  outro('link');
  return 1;
}
