import { intro, outro, section, fact, row, attention, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';

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

interface BulkResult {
  label: string;
  sent: number;
  failed: number;
  results: Array<{ to: string; status: string; error?: string }>;
}

/** Send one text to many recipients, throttled + capped (send_bulk). */
export async function runSendBulk(recipients: string[], text: string, from?: string, raw?: boolean): Promise<number> {
  intro('whatsappman — send-bulk');
  try {
    const res = await request<BulkResult>('send_bulk', { from, to: recipients, text, raw });
    section('bulk result');
    fact(`via "${res.label}": ${res.sent} sent, ${res.failed} failed`, res.failed === 0);
    for (const r of res.results) {
      if (r.status === 'failed') attention(`${r.to}: ${r.error ?? 'failed'}`);
      else row(`${r.to}: sent`);
    }
    outro('send-bulk');
    return res.failed === 0 ? 0 : 1;
  } catch (err) {
    return reportSendError(err, 'send-bulk');
  }
}
