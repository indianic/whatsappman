import { readScheduled, addScheduled, updateScheduled } from '../config/scheduled.js';
import { appendSent } from '../audit.js';
import { notify } from './notify.js';
import type { SessionManager } from './session-manager.js';
import type { ScheduledEntry } from '../config/schema.js';

/**
 * Daemon-held scheduling. Because the daemon is always-on, a "send at 9am" is
 * just a persisted entry + an in-process timer — no OS ticker needed (that was
 * mailman's workaround for having no daemon). On boot, load() re-arms every
 * pending entry, so a restart doesn't drop schedules. See docs/PLAN.md.
 */

// setTimeout caps out at 2^31-1 ms (~24.8 days); for longer waits we re-arm.
const MAX_TIMEOUT = 2_147_483_647;

/** Delay until fireAt, floored at 0 and capped at the setTimeout max. Pure (testable). */
export function computeDelayMs(fireAtMs: number, nowMs: number): number {
  return Math.min(MAX_TIMEOUT, Math.max(0, fireAtMs - nowMs));
}

export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private sm: SessionManager) {}

  /** Re-arm every still-pending entry (called on daemon boot). */
  load(): void {
    for (const e of readScheduled()) {
      if (e.status === 'pending') this.arm(e);
    }
  }

  schedule(entry: ScheduledEntry): void {
    addScheduled(entry);
    this.arm(entry);
  }

  private arm(entry: ScheduledEntry): void {
    const existing = this.timers.get(entry.id);
    if (existing) clearTimeout(existing);
    const delay = computeDelayMs(new Date(entry.fireAt).getTime(), Date.now());
    const t = setTimeout(() => {
      // If the real fire time is still in the future (long-delay re-arm), re-arm;
      // otherwise fire now.
      if (new Date(entry.fireAt).getTime() - Date.now() > 1000) this.arm(entry);
      else void this.fire(entry.id);
    }, delay);
    // Don't keep the process alive solely for a timer.
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(entry.id, t);
  }

  cancel(id: string): boolean {
    const entries = readScheduled();
    const e = entries.find((x) => x.id === id);
    if (!e || e.status !== 'pending') return false;
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    updateScheduled(id, { status: 'cancelled' });
    return true;
  }

  list(status?: ScheduledEntry['status']): ScheduledEntry[] {
    const all = readScheduled();
    return status ? all.filter((e) => e.status === status) : all;
  }

  /** Fire a due entry: pre-send health check, dispatch, record the outcome. */
  private async fire(id: string): Promise<void> {
    const entry = readScheduled().find((e) => e.id === id);
    if (!entry || entry.status !== 'pending') return;
    this.timers.delete(id);

    const health = this.sm.healthCheck(entry.from);
    if (!health.canSend) {
      const error = health.reason ?? 'session not connected at fire time';
      updateScheduled(id, { status: 'failed', error });
      appendSent({
        ts: new Date().toISOString(),
        from: entry.from,
        toJid: entry.toJid,
        toName: entry.toName,
        kind: entry.kind,
        messageId: '',
        status: 'failed',
        via: 'schedule',
        error,
      });
      notify('WhatsApp scheduled send failed', `${entry.toName}: ${error}`);
      return;
    }

    try {
      const r = await this.sm.sendDraft(entry);
      updateScheduled(id, { status: 'sent', messageId: r.messageId });
      appendSent({
        ts: new Date().toISOString(),
        from: entry.from,
        toJid: entry.toJid,
        toName: entry.toName,
        kind: entry.kind,
        messageId: r.messageId,
        status: 'sent',
        via: 'schedule',
      });
      notify('WhatsApp scheduled message sent', `to ${entry.toName} · ${entry.kind}`);
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      updateScheduled(id, { status: 'failed', error });
      appendSent({
        ts: new Date().toISOString(),
        from: entry.from,
        toJid: entry.toJid,
        toName: entry.toName,
        kind: entry.kind,
        messageId: '',
        status: 'failed',
        via: 'schedule',
        error,
      });
      notify('WhatsApp scheduled send failed', `${entry.toName}: ${error}`);
    }
  }

  /** Clear all pending timers (daemon shutdown). Entries stay on disk. */
  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
