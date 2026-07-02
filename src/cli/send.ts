import { intro, outro, section, fact, row, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';

interface SendResult {
  label: string;
  toJid: string;
  messageId: string;
  status: string;
}

/**
 * Quick terminal send: `whatsappman send <to> <text> [--from <label>]`. A
 * direct send (the draft/confirm preview flow arrives with the MCP tools in
 * Phase 3). Errors render with their code + the fix-it next steps.
 */
export async function runSend(to: string, text: string, from?: string): Promise<number> {
  intro('whatsappman — send');
  try {
    const res = await request<SendResult>('send_text', { from, to, text });
    section('sent');
    fact(`via "${res.label}" → ${res.toJid}`, true);
    row(`message id: ${res.messageId}`);
    outro('send');
    return 0;
  } catch (err) {
    if (err instanceof WhatsAppManError) {
      fail(`${err.code}: ${err.message}`);
      for (const step of err.nextSteps ?? []) row(step);
    } else {
      fail(String((err as Error)?.message ?? err));
    }
    outro('send');
    return 1;
  }
}
