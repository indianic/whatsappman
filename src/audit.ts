import fs from 'node:fs';
import { sentLogPath } from './config/paths.js';

/**
 * Append-only send log — metadata only (never message bodies or inbound
 * content). Powers list_recent. Rotates to sent.jsonl.1 on overflow so it can't
 * grow unbounded. See docs/SECURITY.md (logging & data leakage).
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

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

function rotateIfNeeded(file: string): void {
  try {
    const size = fs.statSync(file).size;
    if (size >= MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`); // keep one previous generation
    }
  } catch {
    // no file yet, or stat failed — nothing to rotate
  }
}

export function appendSent(entry: SentLogEntry): void {
  try {
    const file = sentLogPath();
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Logging must never break the send flow.
  }
}

/** Read the most recent send-log entries (newest first), optionally by session. */
export function readRecent(limit = 20, from?: string): SentLogEntry[] {
  let raw = '';
  try {
    raw = fs.readFileSync(sentLogPath(), 'utf8');
  } catch {
    return [];
  }
  const entries: SentLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SentLogEntry;
      if (!from || e.from === from) entries.push(e);
    } catch {
      // skip a corrupt line
    }
  }
  return entries.reverse().slice(0, Math.max(0, limit));
}
