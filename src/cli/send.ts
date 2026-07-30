import { intro, outro, section, fact, row, attention, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import type { SessionSummary } from '../status.js';

interface SendResult {
  label: string;
  toJid: string;
  messageId: string;
  status: string;
}

function reportSendError(err: unknown, label: string): number {
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
 * Quick terminal send: `whatsappman send <to> <text> [--from <label>]`. A
 * direct send (the draft/confirm preview flow arrives with the MCP tools in
 * Phase 3). Errors render with their code + the fix-it next steps.
 */
export async function runSend(to: string, text: string, from?: string, raw?: boolean): Promise<number> {
  intro('whatsappman — send');
  try {
    const res = await request<SendResult>('send_text', { from, to, text, raw });
    section('sent');
    fact(`via "${res.label}" → ${res.toJid}`, true);
    row(`message id: ${res.messageId}`);
    outro('send');
    return 0;
  } catch (err) {
    return reportSendError(err, 'send');
  }
}

export interface MediaSendOpts {
  from?: string;
  to: string;
  kind: 'image' | 'document' | 'location' | 'contact';
  path?: string;
  caption?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  contactName?: string;
  contactPhone?: string;
  raw?: boolean;
}

/**
 * Send a non-text message from the terminal. Routed through draft_message →
 * confirm_send (running the command IS the human confirmation), so it reuses
 * the same resolution + pre-send health check as the MCP path.
 */
export async function runSendMedia(opts: MediaSendOpts): Promise<number> {
  intro(`whatsappman — send ${opts.kind}`);
  try {
    const draft = await request<{ draftId: string; preview: { summary: string; toName: string } }>(
      'draft_message',
      {
        from: opts.from,
        to: opts.to,
        kind: opts.kind,
        text: opts.caption,
        path: opts.path,
        latitude: opts.latitude,
        longitude: opts.longitude,
        name: opts.name,
        contactName: opts.contactName,
        contactPhone: opts.contactPhone,
        raw: opts.raw,
      },
    );
    section('preview');
    row(`to: ${draft.preview.toName}`);
    row(draft.preview.summary);
    const res = await request<SendResult>('confirm_send', { draftId: draft.draftId });
    section('sent');
    fact(`via "${res.label}" → ${res.toJid}`, true);
    row(`message id: ${res.messageId}`);
    outro('send');
    return 0;
  } catch (err) {
    return reportSendError(err, 'send');
  }
}

/**
 * `whatsappman me <text>` — message yourself, the note-to-self inbox
 * (docs/USE-CASES.md #137, #141). Resolves the sending number's OWN phone, so
 * you never have to remember or type it: the message lands in your own chat.
 */
export async function runMe(text: string, from?: string): Promise<number> {
  intro('whatsappman — me');
  try {
    const { sessions } = await request<{ sessions: SessionSummary[] }>('list_sessions');
    const mine = from
      ? sessions.find((s) => s.label === from)
      : (sessions.find((s) => s.isDefault) ?? (sessions.length === 1 ? sessions[0] : undefined));
    if (!mine) {
      fail(from ? `no number labelled "${from}"` : 'no default number set — run: whatsappman default');
      outro('me');
      return 1;
    }
    if (!mine.phone) {
      fail(`"${mine.label}" has no resolved phone number yet (is it connected?)`);
      row(`run: whatsappman status ${mine.label}`);
      outro('me');
      return 1;
    }
    const res = await request<SendResult>('send_text', { from: mine.label, to: mine.phone, text });
    section('sent');
    fact(`note to self via "${res.label}"`, true);
    row(`message id: ${res.messageId}`);
    outro('me');
    return 0;
  } catch (err) {
    return reportSendError(err, 'me');
  }
}

interface PresenceResult {
  label: string;
  toJid: string;
  toName: string;
  presence: string;
}

/** Friendly aliases → the canonical Baileys presence states. Lets a user type
 *  the obvious word (`typing`, `online`) instead of Baileys' `composing` etc. */
export const PRESENCE_ALIASES: Record<string, 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'> = {
  typing: 'composing',
  composing: 'composing',
  online: 'available',
  available: 'available',
  offline: 'unavailable',
  unavailable: 'unavailable',
  recording: 'recording',
  paused: 'paused',
  stop: 'paused',
};

/**
 * Send a presence indicator ("typing…"/online/…) to a recipient — a status
 * signal, not a message: no content is delivered. Handy in scripts to show a
 * human-like "typing…" just before a `send`.
 */
export async function runPresence(
  to: string,
  kind: string,
  from?: string,
  alreadyIntroed = false,
): Promise<number> {
  if (!alreadyIntroed) intro('whatsappman — presence');
  const presence = PRESENCE_ALIASES[kind?.toLowerCase()];
  if (!presence) {
    fail(`unknown presence "${kind}" — use one of: typing, online, offline, recording, paused`);
    outro('presence');
    return 1;
  }
  try {
    const res = await request<PresenceResult>('send_presence', { from, to, presence });
    section('presence');
    fact(`"${res.presence}" → ${res.toName} via "${res.label}"`, true);
    outro('presence');
    return 0;
  } catch (err) {
    return reportSendError(err, 'presence');
  }
}

interface BulkResult {
  label: string;
  sent: number;
  failed: number;
  skipped?: number;
  aborted?: string | null;
  results: Array<{ to: string; status: string; error?: string }>;
}

/** Send one text to many recipients, throttled + capped (send_bulk). */
export async function runSendBulk(recipients: string[], text: string, from?: string, raw?: boolean): Promise<number> {
  intro('whatsappman — send-bulk');
  try {
    const res = await request<BulkResult>('send_bulk', { from, to: recipients, text, raw });
    section('bulk result');
    const skipped = res.skipped ?? 0;
    const tally = `${res.sent} sent, ${res.failed} failed${skipped ? `, ${skipped} skipped` : ''}`;
    fact(`via "${res.label}": ${tally}`, res.failed === 0);
    // An aborted batch is the headline, not a footnote: the remaining
    // recipients were never contacted, and the reason is a ban risk.
    if (res.aborted) {
      attention(res.aborted);
      attention(`${skipped} recipient(s) were NOT contacted — re-run for them once the number is healthy`);
    }
    for (const r of res.results) {
      if (r.status === 'failed') attention(`${r.to}: ${r.error ?? 'failed'}`);
      else if (r.status === 'skipped') row(`${r.to}: skipped (batch stopped)`);
      else row(`${r.to}: sent`);
    }
    outro('send-bulk');
    return res.failed === 0 ? 0 : 1;
  } catch (err) {
    return reportSendError(err, 'send-bulk');
  }
}
