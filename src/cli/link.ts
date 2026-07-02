import QRCode from 'qrcode';
import { intro, outro, section, fact, row, attention, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { startDaemon } from './daemon-control.js';
import { isDaemonAlive } from '../daemon/lock.js';
import { normalizeLabel } from '../config/sessions.js';
import { requireTty } from './interactive.js';
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
 * Decide whether an already-connected `link` should nudge the user toward
 * linking an ADDITIONAL number. True only for a bare `whatsappman link` (no
 * explicit label) that lands on a live number — the classic "I wanted to add a
 * second number but didn't know it needs its own label" case. An explicit
 * `link <label>` or a `relink` just reports the connected state as-is.
 * Pure + exported so the multi-number on-ramp is unit-testable without IPC.
 */
export function shouldSuggestAdditionalNumber(
  method: 'link' | 'relink',
  explicit: boolean,
  status: string,
): boolean {
  return method === 'link' && !explicit && status === 'connected';
}

/**
 * Link a WhatsApp number. Starts the daemon if needed, asks it to begin
 * pairing, renders the QR in the terminal, and polls until the number connects.
 * The actual QR scan is done by the user on their phone.
 */
export async function runLink(rawLabel: string | undefined): Promise<number> {
  // `explicit` distinguishes `link work` / `link --label work` (the user wants a
  // specific number) from a bare `link` (defaults to "default"). It changes what
  // we show when the target is already connected: an explicit label just reports
  // "already connected", but a bare `link` on a live default means the user most
  // likely wants to ADD another number — so we guide them to a labelled link.
  const explicit = rawLabel != null && rawLabel.trim() !== '';
  return linkFlow(normalizeLabel(rawLabel ?? 'default'), 'link', explicit);
}

/** Re-pair an expired/logged-out number with a fresh QR (keeps history). */
export async function runRelink(rawLabel: string | undefined): Promise<number> {
  if (!rawLabel) {
    intro('whatsappman — relink');
    fail('usage: whatsappman relink <label>');
    outro('relink');
    return 1;
  }
  return linkFlow(normalizeLabel(rawLabel), 'relink', true);
}

async function linkFlow(
  label: string,
  method: 'link' | 'relink',
  explicit: boolean,
): Promise<number> {
  // Pairing renders a QR to scan — pointless (and would hang polling) without a
  // real terminal, so refuse early in an AI-tool shell / pipe.
  if (!requireTty(`whatsappman ${method}`)) return 1;

  intro(`whatsappman — ${method} "${label}"`);

  if (!isDaemonAlive()) {
    row('starting daemon…');
    const ok = await startDaemon();
    if (!ok) {
      fail('could not start the daemon — see ~/.whatsappman/logs/daemon.err.log');
      outro(method);
      return 1;
    }
  }

  let state: LinkState;
  try {
    state = await request<LinkState>(method, { label });
  } catch (err) {
    return failWith(err, method);
  }

  if (state.status === 'connected') {
    section('done');
    fact(`"${label}" is already connected`, true);
    // A bare `whatsappman link` (no label) that lands on an already-connected
    // number almost always means the user wanted to add ANOTHER number but did
    // not realise each one needs its own label. Point the way instead of
    // dead-ending — this is the multi-number on-ramp.
    if (shouldSuggestAdditionalNumber(method, explicit, state.status)) {
      row('');
      row('to link an ADDITIONAL number, give it its own label:');
      row('  whatsappman link --label <name>     (e.g. --label work)');
      row('then pick which one Claude sends from by default:');
      row('  whatsappman default <name>');
      row('see all linked numbers with:  whatsappman numbers');
    }
    outro(method);
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
      outro(method);
      return 0;
    }

    await sleep(POLL_INTERVAL_MS);
    try {
      state = await request<LinkState>('link_status', { label });
    } catch (err) {
      return failWith(err, method);
    }
  }

  attention(`timed out waiting for the QR to be scanned — run ${method} again to retry`);
  outro(method);
  return 1;
}

function failWith(err: unknown, method: string): number {
  if (err instanceof WhatsAppManError) {
    fail(`${err.code}: ${err.message}`);
    for (const step of err.nextSteps ?? []) row(step);
  } else {
    fail(String((err as Error)?.message ?? err));
  }
  outro(method);
  return 1;
}
