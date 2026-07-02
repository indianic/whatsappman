import crypto from 'node:crypto';
import { readSettings } from '../config/state.js';

/**
 * In-memory draft store — the daemon's half of the draft → confirm → send
 * safety flow. Drafts never touch disk: kill the daemon mid-draft and a later
 * confirm_send returns DRAFT_NOT_FOUND rather than half-sending. See
 * docs/PLAN.md. confirm_send is made idempotent by markSent storing the result
 * and get() returning the sent draft unchanged on replay.
 */

export type DraftKind = 'text';
export type DraftState = 'pending' | 'sent' | 'cancelled';

export interface SendResultData {
  messageId: string;
  to: string;
  sentAt: string;
}

export interface Draft {
  id: string;
  from: string; // session label
  toJid: string;
  toName: string;
  kind: DraftKind;
  text: string;
  createdAtMs: number;
  expiresAtMs: number;
  state: DraftState;
  result?: SendResultData;
}

export interface NewDraft {
  from: string;
  toJid: string;
  toName: string;
  kind: DraftKind;
  text: string;
}

export class DraftStore {
  private drafts = new Map<string, Draft>();

  private ttlMs(): number {
    return readSettings().draftTtlMinutes * 60_000;
  }

  isExpired(d: Draft, nowMs: number = Date.now()): boolean {
    return d.state === 'pending' && nowMs > d.expiresAtMs;
  }

  create(input: NewDraft): Draft {
    const now = Date.now();
    const draft: Draft = {
      id: crypto.randomUUID(),
      ...input,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs(),
      state: 'pending',
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  get(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  /** Idempotent: records the send result and flips state to 'sent'. */
  markSent(id: string, result: SendResultData): void {
    const d = this.drafts.get(id);
    if (d) {
      d.state = 'sent';
      d.result = result;
    }
  }

  cancel(id: string): boolean {
    const d = this.drafts.get(id);
    if (!d || d.state !== 'pending') return false;
    d.state = 'cancelled';
    return true;
  }

  /** Drop drafts that expired a while ago, to bound memory. */
  sweep(nowMs: number = Date.now()): void {
    for (const [id, d] of this.drafts) {
      if (d.state !== 'pending' && nowMs - d.createdAtMs > 3_600_000) {
        this.drafts.delete(id);
      }
    }
  }
}
