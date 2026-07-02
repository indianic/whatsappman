import type { WASocket } from '@whiskeysockets/baileys';
import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * Recipient resolution — turn a human reference (JID, phone number, saved
 * contact name, or group name) into a WhatsApp JID. Adapted from the mcphub
 * plugin's contact logic, minus the DB. Pure functions given a socket + the
 * per-session contacts cache (maintained by SessionManager from Baileys
 * contacts events). See docs/SKILLS.md (resolve_recipient).
 */

export type RecipientKind = 'individual' | 'group';
export interface RecipientMatch {
  jid: string;
  name: string;
  kind: RecipientKind;
}
export interface GroupInfo {
  jid: string;
  subject: string;
  participantsCount: number;
}

function looksLikeJid(q: string): boolean {
  return q.includes('@s.whatsapp.net') || q.includes('@g.us') || q.includes('@lid');
}

function looksLikePhone(q: string): boolean {
  const digits = q.replace(/\D/g, '');
  return digits.length >= 7 && /^[+\d\s()-]+$/.test(q.trim());
}

function phoneToJid(q: string): string {
  return `${q.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** List the groups the session participates in. */
export async function listGroups(socket: WASocket): Promise<GroupInfo[]> {
  const map = await socket.groupFetchAllParticipating();
  return Object.values(map).map((g) => ({
    jid: g.id,
    subject: g.subject ?? '(no subject)',
    participantsCount: g.participants?.length ?? 0,
  }));
}

/**
 * Resolve a query to zero, one, or many recipient candidates. The caller
 * (draft_message) treats one match as success, many as AMBIGUOUS_RECIPIENT, and
 * zero as an error.
 */
export async function resolveRecipient(
  socket: WASocket,
  contacts: Map<string, string>, // jid -> display name
  query: string,
): Promise<RecipientMatch[]> {
  const q = query.trim();

  // 1) Already a JID → passthrough.
  if (looksLikeJid(q)) {
    return [{ jid: q, name: q.split('@')[0], kind: q.includes('@g.us') ? 'group' : 'individual' }];
  }

  // 2) Phone number → JID, validated against WhatsApp.
  if (looksLikePhone(q)) {
    const jid = phoneToJid(q);
    let onWa: Awaited<ReturnType<typeof socket.onWhatsApp>>;
    try {
      onWa = await socket.onWhatsApp(jid);
    } catch {
      onWa = undefined;
    }
    const hit = onWa?.find((r) => r.exists);
    if (!hit) {
      throw new WhatsAppManError(
        ErrorCode.RECIPIENT_NOT_ON_WHATSAPP,
        `${q} is not a WhatsApp user`,
      );
    }
    return [{ jid: hit.jid ?? jid, name: q.replace(/\D/g, ''), kind: 'individual' }];
  }

  // 3) Name → match groups (by subject) and contacts (by name), case-insensitive.
  const needle = q.toLowerCase();
  const matches: RecipientMatch[] = [];

  try {
    for (const g of await listGroups(socket)) {
      if (g.subject.toLowerCase().includes(needle)) {
        matches.push({ jid: g.jid, name: g.subject, kind: 'group' });
      }
    }
  } catch {
    // group fetch can fail if the socket just connected; ignore
  }

  for (const [jid, name] of contacts) {
    if (name && name.toLowerCase().includes(needle)) {
      matches.push({ jid, name, kind: 'individual' });
    }
  }

  if (matches.length === 0) {
    throw new WhatsAppManError(
      ErrorCode.INVALID_JID,
      `no contact or group matches "${q}" — use a phone number or a JID`,
    );
  }

  // De-dupe by JID (a name could match a contact that is also a group admin, etc.)
  const seen = new Set<string>();
  return matches.filter((m) => (seen.has(m.jid) ? false : (seen.add(m.jid), true)));
}
