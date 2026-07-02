import fs from 'node:fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import {
  authDir,
  sessionDir,
  readMeta,
  writeMeta,
  initialMeta,
  listSessionLabels,
  hasCreds,
  deleteSessionDir,
} from '../config/sessions.js';
import { readState, writeState, readSettings } from '../config/state.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';
import {
  resolveRecipient as resolveRecipientSvc,
  listGroups as listGroupsSvc,
  type RecipientMatch,
  type GroupInfo,
} from './contact-service.js';
import { validateBulk } from './bulk.js';
import type { SessionStatus, SessionMeta } from '../config/schema.js';
import type { SessionSummary } from '../status.js';

/** The minimum a dispatchable message needs — satisfied by both a Draft and a
 *  scheduled entry, so sendDraft serves the confirm_send and scheduler paths. */
export interface SendableMessage {
  from: string;
  toJid: string;
  kind: 'text' | 'image' | 'document' | 'location' | 'contact';
  text?: string;
  attachment?: { absPath: string; filename: string; mimetype: string };
  latitude?: number;
  longitude?: number;
  locationName?: string;
  contactName?: string;
  contactPhone?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildVcard(name: string, phone: string): string {
  const waid = phone.replace(/\D/g, '');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${phone}`,
    'END:VCARD',
  ].join('\n');
}

const logger = pino({ level: 'silent' });

interface ActiveSession {
  socket: WASocket | null;
  status: SessionStatus;
  qr: string | null; // raw QR payload (rendered to a terminal QR by the CLI)
  phone: string | null;
  reconnectTimer: NodeJS.Timeout | null;
  contacts: Map<string, string>; // jid -> display name (for name resolution)
}

const RECONNECT_DELAY_MS = 3000;

/**
 * Owns the Baileys socket for each linked number. Single-owner, filesystem-
 * backed (auth under sessions/<label>/auth/, metadata in meta.json) — adapted
 * from the mcphub baileys-whatsapp plugin's session manager, with the DB/Redis/
 * customer-scoping stripped out. See docs/PLAN.md.
 */
export class SessionManager {
  private sessions = new Map<string, ActiveSession>();

  private ensure(label: string): ActiveSession {
    let s = this.sessions.get(label);
    if (!s) {
      s = {
        socket: null,
        status: 'disconnected',
        qr: null,
        phone: null,
        reconnectTimer: null,
        contacts: new Map(),
      };
      this.sessions.set(label, s);
    }
    return s;
  }

  private patchMeta(label: string, patch: Partial<SessionMeta>): void {
    const current = readMeta(label) ?? initialMeta(label);
    writeMeta({ ...current, ...patch, label });
  }

  private formatJid(to: string): string {
    if (to.includes('@')) return to; // already a JID (individual or @g.us group)
    const digits = to.replace(/\D/g, '');
    if (digits.length === 0) {
      throw new WhatsAppManError(ErrorCode.INVALID_JID, `cannot resolve recipient "${to}"`);
    }
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Open (or re-open) the Baileys socket for a label. If creds already exist it
   * reconnects silently; otherwise it emits a QR (captured on the session for
   * the CLI to render). Idempotent: a live/connecting session is left alone.
   */
  async connect(label: string): Promise<void> {
    const s = this.ensure(label);
    if (s.socket && (s.status === 'connected' || s.status === 'connecting')) return;

    fs.mkdirSync(sessionDir(label), { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir(label));

    // Try to use the latest protocol version, but never block linking on a
    // network hiccup — Baileys falls back to its bundled version if omitted.
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }

    const socket = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: false,
    });

    s.socket = socket;
    s.status = hasCreds(label) ? 'connecting' : 'qr_pending';
    this.patchMeta(label, { status: s.status });

    socket.ev.on('creds.update', saveCreds);

    // Maintain a name→jid cache for recipient resolution (best-effort; WhatsApp
    // populates this over time as chats/contacts sync).
    const cacheContact = (c: { id?: string; name?: string; notify?: string; verifiedName?: string }) => {
      const name = c.name || c.verifiedName || c.notify;
      if (c.id && name) s.contacts.set(c.id, name);
    };
    socket.ev.on('contacts.upsert', (cs) => cs.forEach(cacheContact));
    socket.ev.on('contacts.update', (cs) => cs.forEach((c) => cacheContact(c as never)));

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        s.status = 'qr_pending';
        s.qr = qr;
        this.patchMeta(label, { status: 'qr_pending' });
      }

      if (connection === 'open') {
        s.status = 'connected';
        s.qr = null;
        s.phone = socket.user?.id?.split(':')[0]?.split('@')[0] ?? null;
        const now = new Date().toISOString();
        this.patchMeta(label, {
          status: 'connected',
          phone: s.phone,
          linkedAt: readMeta(label)?.linkedAt ?? now,
          lastConnectedAt: now,
        });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        s.qr = null;

        if (loggedOut) {
          // Device removed / creds invalid — stop retrying, require a relink.
          s.status = 'needs_relink';
          s.socket = null;
          this.patchMeta(label, { status: 'needs_relink' });
        } else {
          s.status = 'disconnected';
          this.patchMeta(label, { status: 'disconnected' });
          // Auto-reconnect transient drops (network, restart-required, etc.).
          if (!s.reconnectTimer) {
            s.reconnectTimer = setTimeout(() => {
              s.reconnectTimer = null;
              if (this.sessions.has(label)) this.connect(label).catch(() => {});
            }, RECONNECT_DELAY_MS);
          }
        }
      }
    });
  }

  /** Current QR payload for a linking session, or null. */
  getQr(label: string): string | null {
    return this.sessions.get(label)?.qr ?? null;
  }

  statusOf(label: string): SessionStatus {
    return this.sessions.get(label)?.status ?? readMeta(label)?.status ?? 'disconnected';
  }

  /** Live summaries of every session (in-memory state wins over on-disk meta). */
  listSummaries(): SessionSummary[] {
    const defaultSession = readState()?.defaultSession ?? null;
    const labels = new Set<string>([...this.sessions.keys(), ...listSessionLabels()]);
    return [...labels].sort().map((label) => {
      const live = this.sessions.get(label);
      const meta = readMeta(label);
      return {
        label,
        phone: live?.phone ?? meta?.phone ?? null,
        status: live?.status ?? meta?.status ?? 'disconnected',
        lastConnectedAt: meta?.lastConnectedAt ?? null,
        isDefault: defaultSession === label,
      };
    });
  }

  /** Resolve which session a send should use: explicit `from`, else the default,
   *  else the sole session; otherwise NO_DEFAULT_SESSION. */
  private resolveSendLabel(from?: string): string {
    if (from) return from;
    const state = readState();
    if (state?.defaultSession) return state.defaultSession;
    const labels = listSessionLabels();
    if (labels.length === 1) return labels[0];
    if (labels.length === 0) {
      throw new WhatsAppManError(ErrorCode.NO_DEFAULT_SESSION, 'no WhatsApp numbers linked yet', [
        'run: whatsappman link',
      ]);
    }
    throw new WhatsAppManError(
      ErrorCode.NO_DEFAULT_SESSION,
      'no default number set and more than one is linked — pass a "from" label',
      ['run: whatsappman default <label>'],
    );
  }

  private connectedSocket(label: string): WASocket {
    const s = this.sessions.get(label);
    if (!s) {
      throw new WhatsAppManError(ErrorCode.SESSION_NOT_FOUND, `no session "${label}"`, [
        `run: whatsappman link --label ${label}`,
      ]);
    }
    if (s.status === 'needs_relink' || s.status === 'logged_out') {
      throw new WhatsAppManError(ErrorCode.NEEDS_RELINK, `session "${label}" needs relinking`, [
        `run: whatsappman relink ${label}`,
      ]);
    }
    if (s.status !== 'connected' || !s.socket) {
      throw new WhatsAppManError(
        ErrorCode.SESSION_NOT_CONNECTED,
        `session "${label}" is ${s.status}`,
      );
    }
    return s.socket;
  }

  async sendText(
    from: string | undefined,
    to: string,
    text: string,
  ): Promise<{ label: string; toJid: string; messageId: string; status: string }> {
    const label = this.resolveSendLabel(from);
    const socket = this.connectedSocket(label);
    const jid = this.formatJid(to);
    const result = await socket.sendMessage(jid, { text });
    return { label, toJid: jid, messageId: result?.key?.id ?? 'unknown', status: 'sent' };
  }

  /** Public wrapper over the default/sole-session resolution logic. */
  resolveLabel(from?: string): string {
    return this.resolveSendLabel(from);
  }

  /** Resolve a recipient reference to candidate JIDs (for draft_message / resolve_recipient). */
  async resolveRecipient(label: string, query: string): Promise<RecipientMatch[]> {
    const socket = this.connectedSocket(label);
    const s = this.sessions.get(label)!;
    return resolveRecipientSvc(socket, s.contacts, query);
  }

  async listGroups(label: string): Promise<GroupInfo[]> {
    const socket = this.connectedSocket(label);
    return listGroupsSvc(socket);
  }

  /** Send to an already-resolved JID (used by confirm_send). */
  async sendTextToJid(
    label: string,
    jid: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const socket = this.connectedSocket(label);
    const result = await socket.sendMessage(jid, { text });
    return { messageId: result?.key?.id ?? 'unknown' };
  }

  /** Dispatch a confirmed message of any kind to its resolved JID. The file
   *  bytes for image/document are read here (at send time). Serves both
   *  confirm_send (a Draft) and the scheduler (a scheduled entry). */
  async sendDraft(draft: SendableMessage): Promise<{ messageId: string }> {
    const socket = this.connectedSocket(draft.from);
    const jid = draft.toJid;
    let result;
    switch (draft.kind) {
      case 'text':
        result = await socket.sendMessage(jid, { text: draft.text ?? '' });
        break;
      case 'image': {
        const buf = fs.readFileSync(draft.attachment!.absPath);
        result = await socket.sendMessage(jid, { image: buf, caption: draft.text || undefined });
        break;
      }
      case 'document': {
        const a = draft.attachment!;
        const buf = fs.readFileSync(a.absPath);
        result = await socket.sendMessage(jid, {
          document: buf,
          fileName: a.filename,
          mimetype: a.mimetype,
          caption: draft.text || undefined,
        });
        break;
      }
      case 'location':
        result = await socket.sendMessage(jid, {
          location: {
            degreesLatitude: draft.latitude!,
            degreesLongitude: draft.longitude!,
            name: draft.locationName || undefined,
          },
        });
        break;
      case 'contact': {
        const vcard = buildVcard(draft.contactName!, draft.contactPhone!);
        result = await socket.sendMessage(jid, {
          contacts: { displayName: draft.contactName!, contacts: [{ vcard }] },
        });
        break;
      }
    }
    return { messageId: result?.key?.id ?? 'unknown' };
  }

  /** Send one text to many recipients, throttled, capped. One failure doesn't
   *  abort the batch. */
  async sendBulk(
    from: string | undefined,
    recipients: string[],
    text: string,
  ): Promise<{ label: string; sent: number; failed: number; results: Array<{ to: string; status: string; error?: string }> }> {
    const settings = readSettings();
    validateBulk(recipients, settings.maxBulkRecipients);
    const label = this.resolveSendLabel(from);
    const socket = this.connectedSocket(label);

    const results: Array<{ to: string; status: string; error?: string }> = [];
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < recipients.length; i++) {
      const to = recipients[i];
      try {
        const jid = this.formatJid(to);
        await socket.sendMessage(jid, { text });
        results.push({ to, status: 'sent' });
        sent++;
      } catch (err) {
        results.push({ to, status: 'failed', error: String((err as Error)?.message ?? err) });
        failed++;
      }
      if (i < recipients.length - 1) await sleep(settings.defaultDelayMs);
    }
    return { label, sent, failed, results };
  }

  /** Drop the live socket but keep creds on disk (fast reconnect later). */
  disconnect(label: string): { label: string; status: SessionStatus } {
    const s = this.sessions.get(label);
    if (!s) throw new WhatsAppManError(ErrorCode.SESSION_NOT_FOUND, `no session "${label}"`);
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    try {
      s.socket?.end(undefined);
    } catch {
      /* ignore */
    }
    s.socket = null;
    s.qr = null;
    s.status = 'disconnected';
    this.patchMeta(label, { status: 'disconnected' });
    return { label, status: 'disconnected' };
  }

  /** Re-pair a number with a fresh QR: wipe the (invalid) creds, keep meta history. */
  async relink(label: string): Promise<void> {
    const s = this.sessions.get(label);
    if (s?.reconnectTimer) clearTimeout(s.reconnectTimer);
    try {
      s?.socket?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sessions.delete(label);
    fs.rmSync(authDir(label), { recursive: true, force: true });
    this.patchMeta(label, { status: 'qr_pending', phone: null });
    await this.connect(label);
  }

  /** Permanently remove a number: socket + auth creds + meta. */
  deleteSession(label: string): { label: string; deleted: boolean } {
    const s = this.sessions.get(label);
    if (s?.reconnectTimer) clearTimeout(s.reconnectTimer);
    try {
      s?.socket?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sessions.delete(label);
    deleteSessionDir(label);
    const state = readState();
    if (state?.defaultSession === label) writeState({ ...state, defaultSession: null });
    return { label, deleted: true };
  }

  /** Can this session send right now? Never throws. */
  healthCheck(from?: string): {
    label: string | null;
    ok: boolean;
    status: SessionStatus | 'no_session';
    canSend: boolean;
    reason?: string;
  } {
    let label: string;
    try {
      label = this.resolveSendLabel(from);
    } catch (err) {
      return {
        label: null,
        ok: false,
        status: 'no_session',
        canSend: false,
        reason: err instanceof WhatsAppManError ? err.message : 'no session',
      };
    }
    const status = this.statusOf(label);
    const canSend = status === 'connected';
    const reason = canSend
      ? undefined
      : status === 'needs_relink' || status === 'logged_out'
        ? `session "${label}" needs relinking — run: whatsappman relink ${label}`
        : `session "${label}" is ${status}`;
    return { label, ok: canSend, status, canSend, reason };
  }

  /** On daemon boot, bring every already-linked number back online. */
  async reconnectAll(): Promise<void> {
    for (const label of listSessionLabels()) {
      if (hasCreds(label)) {
        this.connect(label).catch(() => {
          /* individual failures are reflected in that session's status */
        });
      }
    }
  }

  /** Close all sockets cleanly (called on daemon shutdown). */
  shutdown(): void {
    for (const s of this.sessions.values()) {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      try {
        s.socket?.end(undefined);
      } catch {
        /* ignore */
      }
    }
  }
}
