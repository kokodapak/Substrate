/**
 * Simple in-memory rate limiter.
 * Not for distributed use — single-server only (P1).
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly timestamps: Map<string, number[]>;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.timestamps = new Map();
  }

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const existing = this.timestamps.get(key) ?? [];
    // Prune timestamps outside the current window
    const recent = existing.filter((t) => t > windowStart);

    if (recent.length >= this.maxRequests) {
      // Oldest timestamp in the window — caller can retry after it expires
      const oldestInWindow = recent[0]!;
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      this.timestamps.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    recent.push(now);
    this.timestamps.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
