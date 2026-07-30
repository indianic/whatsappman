import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * Validate a bulk recipient list against the configured cap. Kept as a pure,
 * socket-free function so the cap logic is unit-testable. See docs/PLAN.md
 * (send_bulk) and docs/SECURITY.md (send-abuse / ban risk).
 */
export function validateBulk(recipients: string[], max: number): void {
  if (recipients.length === 0) {
    throw new WhatsAppManError(ErrorCode.BAD_REQUEST, 'no recipients given');
  }
  if (recipients.length > max) {
    throw new WhatsAppManError(
      ErrorCode.BULK_LIMIT_EXCEEDED,
      `${recipients.length} recipients exceeds the max of ${max} (settings.maxBulkRecipients)`,
    );
  }
}

/**
 * Consecutive failures that stop a batch dead.
 *
 * A run of failures is what WhatsApp throttling or an early block looks like
 * from in here. Continuing to push the remaining recipients at that moment is
 * the single most effective way to turn a warning into a ban, so the batch
 * stops and says why. Isolated failures (one bad number in a list) don't
 * count — the counter resets on every success.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Spread the inter-send delay by ±25%.
 *
 * A batch that fires at exactly 2000ms intervals is machine-obvious, and
 * mechanical regularity is a signal automated-behaviour detection looks for.
 * Jitter costs nothing and makes the cadence look less like a script.
 * `rand` is injectable so the spread is testable rather than flaky.
 */
export function withJitter(ms: number, rand: () => number = Math.random): number {
  if (ms <= 0) return 0;
  const spread = ms * 0.25;
  return Math.max(0, Math.round(ms + (rand() * 2 - 1) * spread));
}

/**
 * Tracks whether a batch should keep going. Extracted from the send loop so the
 * anti-ban decision — the part that protects the number — is unit-testable
 * instead of only reachable through a live socket.
 */
export class BulkGuard {
  private consecutive = 0;
  aborted: string | null = null;

  constructor(private readonly limit: number = CONSECUTIVE_FAILURE_LIMIT) {}

  /** A delivery landed: the run is broken, so an isolated dud number earlier in
   *  the list must not count toward the breaker. */
  recordSuccess(): void {
    this.consecutive = 0;
  }

  /** A delivery failed. Trips the breaker once failures run consecutively. */
  recordFailure(): void {
    this.consecutive++;
    if (this.consecutive >= this.limit && !this.aborted) {
      this.aborted = `stopped after ${this.consecutive} consecutive failures — WhatsApp may be throttling this number`;
    }
  }

  get isAborted(): boolean {
    return this.aborted !== null;
  }
}
