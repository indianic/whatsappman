import fs from 'node:fs';
import { sentLogPath } from './config/paths.js';

/**
 * Append-only send log — metadata only (never message bodies or inbound
 * content). Powers list_recent. Phase 7 adds rotation/size caps; this is the
 * minimal writer. See docs/SECURITY.md (logging & data leakage).
 */
export interface SentLogEntry {
  ts: string; // ISO-8601
  from: string; // session label
  toJid: string;
  toName?: string;
  kind: string;
  messageId: string;
  status: 'sent' | 'failed';
  via?: 'send' | 'schedule';
  error?: string;
}

export function appendSent(entry: SentLogEntry): void {
  try {
    fs.appendFileSync(sentLogPath(), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Logging must never break the send flow.
  }
}
