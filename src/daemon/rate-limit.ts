/**
 * Per-session send rate limiter — an anti-runaway / anti-abuse guard, not a
 * strict throttle. A rogue same-user caller (or a buggy loop) could otherwise
 * blast hundreds of messages and get the WhatsApp number banned. A token
 * bucket, sized generously so normal interactive/bulk use never hits it, but a
 * runaway is stopped with RATE_LIMITED. See docs/SECURITY.md (send-abuse).
 *
 * Pure/deterministic given an injected clock, so it's unit-testable without
 * real time. Default: 30-token capacity, refilled 1 token/sec (≈ up to 30
 * quick sends, then ~1/sec sustained).
 */

export interface RateLimitOpts {
  capacity?: number; // max burst
  refillPerSec?: number; // sustained rate
}

interface Bucket {
  tokens: number;
  lastMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(opts: RateLimitOpts = {}) {
    this.capacity = opts.capacity ?? 30;
    this.refillPerSec = opts.refillPerSec ?? 1;
  }

  /** Try to consume one token for `key`. Returns true if allowed. */
  tryConsume(key: string, nowMs: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastMs: nowMs };
      this.buckets.set(key, b);
    }
    // Refill based on elapsed time.
    const elapsedSec = Math.max(0, (nowMs - b.lastMs) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.lastMs = nowMs;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Seconds until at least one token is available for `key`. Reads the current
   * bucket (callers invoke this right after tryConsume, which already refilled
   * to `now`), so no clock arg is needed; `_nowMs` is accepted for call-site
   * symmetry with tryConsume.
   */
  retryAfterSec(key: string, _nowMs: number): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.refillPerSec);
  }
}
