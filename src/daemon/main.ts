import os from 'node:os';
import crypto from 'node:crypto';
import type net from 'node:net';
import { ensureBaseDir } from '../config/paths.js';
import { readState, writeState } from '../config/state.js';
import { acquireLock, releaseLock } from './lock.js';
import { rotateToken, clearToken } from '../ipc/access.js';
import { startIpcServer, type Handler } from '../ipc/server.js';
import { removeStaleSocket } from '../ipc/transport.js';
import { buildStatus } from '../status.js';
import { SessionManager } from './session-manager.js';
import { DraftStore, type NewDraft } from './draft-store.js';
import { Scheduler } from './scheduler.js';
import { resolveAttachment } from './attachments.js';
import { toWhatsAppMarkup } from './markup.js';
import { normalizeLabel, listSessionLabels } from '../config/sessions.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';
import { appendSent, readRecent } from '../audit.js';
import { readSettings, writeSettings } from '../config/state.js';
import type {
  Method,
  SendTextParams,
  SendBulkParams,
  SendPresenceParams,
  RenameSessionParams,
  DraftMessageParams,
  ScheduleSendParams,
  ListRecentParams,
  UpdateSettingsParams,
} from '../ipc/protocol.js';
import type { State, ScheduledEntry } from '../config/schema.js';

/**
 * The always-on daemon. Phase 1 scope: acquire the single-instance lock, mint
 * the capability token, record identity in state.json, and serve ping/status
 * over the local socket. Baileys sessions arrive in Phase 2.
 */
export async function runDaemon(): Promise<void> {
  ensureBaseDir();

  if (!acquireLock()) {
    process.stderr.write('whatsappman: daemon already running\n');
    process.exit(1);
  }

  const startedAtMs = Date.now();
  rotateToken();

  const prev = readState();
  const state: State = {
    schemaVersion: 1,
    daemonId: prev?.daemonId ?? `daemon_${crypto.randomBytes(8).toString('hex')}`,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date(startedAtMs).toISOString(),
    // Preserve the operator's chosen default across restarts.
    defaultSession: prev?.defaultSession ?? null,
  };
  writeState(state);

  const sm = new SessionManager();
  const drafts = new DraftStore();
  const scheduler = new Scheduler(sm);

  const labelFrom = (from?: string) => (from ? normalizeLabel(from) : undefined);
  const fmt = (text: string, raw?: boolean) => (raw ? text : toWhatsAppMarkup(text));

  const handlers = new Map<Method, Handler>([
    ['ping', () => ({ pong: true, pid: process.pid })],
    ['status', () => buildStatus(startedAtMs, sm.listSummaries(), scheduler.list('pending').length)],
    ['list_sessions', () => ({ sessions: sm.listSummaries() })],
    [
      'link',
      async (params) => {
        const label = normalizeLabel((params as { label: string }).label);
        await sm.connect(label);
        return { label, status: sm.statusOf(label), qr: sm.getQr(label) };
      },
    ],
    [
      'link_status',
      (params) => {
        const label = normalizeLabel((params as { label: string }).label);
        return { label, status: sm.statusOf(label), qr: sm.getQr(label) };
      },
    ],
    [
      'send_text',
      async (params) => {
        const p = params as SendTextParams;
        return sm.sendText(labelFrom(p.from), p.to, fmt(p.text, p.raw));
      },
    ],
    [
      'send_bulk',
      async (params) => {
        const p = params as SendBulkParams;
        return sm.sendBulk(labelFrom(p.from), p.to, fmt(p.text, p.raw));
      },
    ],
    [
      'send_presence',
      async (params) => {
        const p = params as SendPresenceParams;
        return sm.sendPresence(labelFrom(p.from), p.to, p.presence);
      },
    ],
    [
      'reconnect',
      async (params) => {
        const label = normalizeLabel((params as { label: string }).label);
        await sm.reconnect(label); // errors SESSION_NOT_FOUND for an unknown label
        return { label, status: sm.statusOf(label) };
      },
    ],
    [
      'disconnect',
      (params) => sm.disconnect(normalizeLabel((params as { label: string }).label)),
    ],
    [
      'relink',
      async (params) => {
        const label = normalizeLabel((params as { label: string }).label);
        await sm.relink(label);
        return { label, status: sm.statusOf(label), qr: sm.getQr(label) };
      },
    ],
    [
      'delete_session',
      (params) => sm.deleteSession(normalizeLabel((params as { label: string }).label)),
    ],
    [
      'rename_session',
      async (params) => {
        const p = params as RenameSessionParams;
        return sm.renameSession(normalizeLabel(p.oldLabel), normalizeLabel(p.newLabel));
      },
    ],
    ['health_check', (params) => sm.healthCheck(labelFrom((params as { from?: string })?.from))],
    [
      'list_groups',
      async (params) => {
        const label = sm.resolveLabel(labelFrom((params as { from?: string })?.from));
        return { groups: await sm.listGroups(label) };
      },
    ],
    [
      'resolve_recipient',
      async (params) => {
        const p = params as { from?: string; query: string };
        const label = sm.resolveLabel(labelFrom(p.from));
        const matches = await sm.resolveRecipient(label, p.query);
        if (matches.length === 1) return matches[0];
        return { candidates: matches, next_steps: matches.map((m) => `${m.name} (${m.jid})`) };
      },
    ],
    [
      'draft_message',
      async (params) => {
        const p = params as DraftMessageParams;
        const label = sm.resolveLabel(labelFrom(p.from));
        const matches = await sm.resolveRecipient(label, p.to);
        if (matches.length > 1) {
          throw new WhatsAppManError(
            ErrorCode.AMBIGUOUS_RECIPIENT,
            `"${p.to}" matches ${matches.length} recipients — be more specific or pass a JID`,
            matches.map((m) => `${m.name} (${m.jid})`),
          );
        }
        const m = matches[0];

        // Markdown → WhatsApp markup for the body / caption (unless raw).
        const bodyText = p.text != null ? fmt(p.text, p.raw) : undefined;

        // Build the per-kind payload + a human-readable preview summary.
        const base = { from: label, toJid: m.jid, toName: m.name };
        let payload: NewDraft;
        let summary: string;
        let attach: { name: string; sizeBytes: number } | undefined;
        const trunc = (t: string) => (t.length > 200 ? `${t.slice(0, 200)}…` : t);

        switch (p.kind) {
          case 'image':
          case 'document': {
            const a = resolveAttachment(p.path!);
            payload = { ...base, kind: p.kind, text: bodyText, attachment: a };
            attach = { name: a.filename, sizeBytes: a.sizeBytes };
            summary = `${p.kind}: ${a.filename} (${(a.sizeBytes / 1024).toFixed(0)} KB)${bodyText ? ` — ${trunc(bodyText)}` : ''}`;
            break;
          }
          case 'location':
            payload = { ...base, kind: 'location', latitude: p.latitude, longitude: p.longitude, locationName: p.name };
            summary = `location ${p.latitude}, ${p.longitude}${p.name ? ` (${p.name})` : ''}`;
            break;
          case 'contact':
            payload = { ...base, kind: 'contact', contactName: p.contactName, contactPhone: p.contactPhone };
            summary = `contact ${p.contactName} — ${p.contactPhone}`;
            break;
          default:
            payload = { ...base, kind: 'text', text: bodyText };
            summary = trunc(bodyText ?? '');
        }

        const draft = drafts.create(payload);
        return {
          draftId: draft.id,
          preview: { from: label, toJid: m.jid, toName: m.name, kind: p.kind, summary, attachment: attach },
          expiresInSec: Math.floor((draft.expiresAtMs - Date.now()) / 1000),
        };
      },
    ],
    [
      'confirm_send',
      async (params) => {
        const { draftId } = params as { draftId: string };
        const d = drafts.get(draftId);
        if (!d) throw new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, `no draft ${draftId}`);
        // Idempotent: a replayed confirm returns the original result, never re-sends.
        if (d.state === 'sent' && d.result) {
          return { messageId: d.result.messageId, status: 'sent', to: d.toName, sentAt: d.result.sentAt };
        }
        if (d.state === 'cancelled') {
          throw new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, `draft ${draftId} was cancelled`);
        }
        if (drafts.isExpired(d)) {
          throw new WhatsAppManError(ErrorCode.DRAFT_EXPIRED, `draft ${draftId} expired`);
        }
        // Pre-send health check — never a false "sent".
        const h = sm.healthCheck(d.from);
        if (!h.canSend) {
          const code =
            h.status === 'needs_relink' || h.status === 'logged_out'
              ? ErrorCode.NEEDS_RELINK
              : h.status === 'no_session'
                ? ErrorCode.SESSION_NOT_FOUND
                : ErrorCode.SESSION_NOT_CONNECTED;
          throw new WhatsAppManError(code, h.reason ?? 'cannot send', [
            `run: whatsappman relink ${d.from}`,
          ]);
        }
        const r = await sm.sendDraft(d);
        const sentAt = new Date().toISOString();
        drafts.markSent(draftId, { messageId: r.messageId, to: d.toJid, sentAt });
        appendSent({
          ts: sentAt,
          from: d.from,
          toJid: d.toJid,
          toName: d.toName,
          kind: d.kind,
          messageId: r.messageId,
          status: 'sent',
          via: 'send',
        });
        return { messageId: r.messageId, status: 'sent', to: d.toName, kind: d.kind, sentAt };
      },
    ],
    [
      'cancel_draft',
      (params) => {
        const { draftId } = params as { draftId: string };
        const ok = drafts.cancel(draftId);
        if (!ok) throw new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, `no pending draft ${draftId}`);
        return { cancelled: true };
      },
    ],
    [
      'schedule_send',
      (params) => {
        const { draftId, fireAt } = params as ScheduleSendParams;
        const d = drafts.get(draftId);
        if (!d) throw new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, `no draft ${draftId}`);
        if (d.state !== 'pending') {
          throw new WhatsAppManError(ErrorCode.DRAFT_NOT_FOUND, `draft ${draftId} is ${d.state}`);
        }
        if (drafts.isExpired(d)) {
          throw new WhatsAppManError(ErrorCode.DRAFT_EXPIRED, `draft ${draftId} expired`);
        }
        const fireMs = new Date(fireAt).getTime();
        if (Number.isNaN(fireMs)) {
          throw new WhatsAppManError(ErrorCode.BAD_REQUEST, `invalid fireAt: ${fireAt}`);
        }
        // Snapshot the draft into the schedule so it no longer depends on the
        // in-memory draft, then consume the draft so it can't also be confirmed.
        const entry: ScheduledEntry = {
          id: crypto.randomUUID(),
          from: d.from,
          toJid: d.toJid,
          toName: d.toName,
          kind: d.kind,
          text: d.text,
          attachment: d.attachment,
          latitude: d.latitude,
          longitude: d.longitude,
          locationName: d.locationName,
          contactName: d.contactName,
          contactPhone: d.contactPhone,
          fireAt: new Date(fireMs).toISOString(),
          createdAt: new Date().toISOString(),
          status: 'pending',
          messageId: null,
          error: null,
        };
        scheduler.schedule(entry);
        drafts.cancel(draftId);
        return { scheduledId: entry.id, fireAt: entry.fireAt };
      },
    ],
    [
      'list_scheduled',
      (params) => {
        const status = (params as { status?: ScheduledEntry['status'] } | undefined)?.status;
        return {
          scheduled: scheduler.list(status).map((e) => ({
            scheduledId: e.id,
            from: e.from,
            toName: e.toName,
            kind: e.kind,
            fireAt: e.fireAt,
            status: e.status,
          })),
        };
      },
    ],
    [
      'cancel_scheduled',
      (params) => {
        const { scheduledId } = params as { scheduledId: string };
        const ok = scheduler.cancel(scheduledId);
        if (!ok) {
          throw new WhatsAppManError(ErrorCode.SCHEDULED_NOT_FOUND, `no pending scheduled send ${scheduledId}`);
        }
        return { cancelled: true };
      },
    ],
    [
      'list_recent',
      (params) => {
        const p = (params as ListRecentParams) ?? {};
        return { sent: readRecent(p.limit ?? 20, p.from) };
      },
    ],
    ['get_settings', () => readSettings()],
    [
      'update_settings',
      (params) => {
        const patch = params as UpdateSettingsParams;
        const next = { ...readSettings(), ...patch };
        writeSettings(next);
        return next;
      },
    ],
    [
      'set_default',
      (params) => {
        const label = normalizeLabel((params as { label: string }).label);
        if (!listSessionLabels().includes(label)) {
          throw new WhatsAppManError(ErrorCode.SESSION_NOT_FOUND, `no session "${label}"`);
        }
        const cur = readState();
        if (cur) writeState({ ...cur, defaultSession: label });
        return { defaultSession: label };
      },
    ],
  ]);

  let server: net.Server;
  try {
    server = await startIpcServer(handlers);
  } catch (err) {
    process.stderr.write(`whatsappman: failed to start IPC server: ${String((err as Error).message)}\n`);
    releaseLock();
    clearToken();
    process.exit(1);
  }

  const shutdown = () => {
    // Clean SIGTERM exit → exit 0 so the OS supervisor (launchd KeepAlive) does
    // NOT treat it as a crash and restart us.
    try {
      scheduler.clearAll();
      sm.shutdown();
      server.close();
    } catch {
      /* ignore */
    }
    removeStaleSocket();
    clearToken();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stdout.write(
    `whatsappman daemon up (pid ${process.pid}, host ${state.hostname})\n`,
  );

  // Bring every already-linked number back online (no-op on first run).
  void sm.reconnectAll();

  // Re-arm any pending scheduled sends (survive restarts).
  scheduler.load();

  // The listening server keeps the event loop alive; nothing else to do.
}
