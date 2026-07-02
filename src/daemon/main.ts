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
import { DraftStore } from './draft-store.js';
import { normalizeLabel, listSessionLabels } from '../config/sessions.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';
import type { Method, SendTextParams, DraftMessageParams } from '../ipc/protocol.js';
import type { State } from '../config/schema.js';

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

  const labelFrom = (from?: string) => (from ? normalizeLabel(from) : undefined);

  const handlers = new Map<Method, Handler>([
    ['ping', () => ({ pong: true, pid: process.pid })],
    ['status', () => buildStatus(startedAtMs, sm.listSummaries())],
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
        return sm.sendText(labelFrom(p.from), p.to, p.text);
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
        const draft = drafts.create({
          from: label,
          toJid: m.jid,
          toName: m.name,
          kind: 'text',
          text: p.text,
        });
        return {
          draftId: draft.id,
          preview: {
            from: label,
            toJid: m.jid,
            toName: m.name,
            kind: 'text',
            summary: p.text.length > 200 ? `${p.text.slice(0, 200)}…` : p.text,
          },
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
        const r = await sm.sendTextToJid(d.from, d.toJid, d.text);
        const sentAt = new Date().toISOString();
        drafts.markSent(draftId, { messageId: r.messageId, to: d.toJid, sentAt });
        return { messageId: r.messageId, status: 'sent', to: d.toName, sentAt };
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

  // The listening server keeps the event loop alive; nothing else to do.
}
