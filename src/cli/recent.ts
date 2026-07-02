import { intro, outro, section, row } from './tree.js';
import { request } from '../ipc/client.js';
import { readRecent, type SentLogEntry } from '../audit.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * Show recent send history from sent.jsonl. Works even when the daemon is down
 * (reads the file directly) since the log is on disk, not daemon state.
 */
export async function runRecent(limit: number, from?: string): Promise<number> {
  intro('whatsappman — recent');
  let sent: SentLogEntry[];
  try {
    const res = await request<{ sent: SentLogEntry[] }>('list_recent', { limit, from });
    sent = res.sent;
  } catch (err) {
    if (err instanceof WhatsAppManError && err.code === ErrorCode.DAEMON_DOWN) {
      sent = readRecent(limit, from); // fall back to reading the file directly
    } else {
      throw err;
    }
  }

  section('recent sends');
  if (sent.length === 0) {
    row('none yet');
  } else {
    for (const e of sent) {
      const mark = e.status === 'sent' ? '✓' : '✗';
      const via = e.via ? ` (${e.via})` : '';
      row(`${mark} ${e.ts}  ${e.from} → ${e.toName ?? e.toJid} · ${e.kind}${via}`);
    }
  }
  outro('recent');
  return 0;
}
