/**
 * Fixed-window counter keyed by client (e.g. IP). In memory, per process;
 * resets on restart. `now` is passed in so the policy stays pure.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly windowMs: number, readonly max: number) {}

  /** Counts a hit; returns the seconds to wait when over the limit, else 0. */
  hit(key: string, now: number): number {
    if (this.hits.size > 10000) {
      for (const [k, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(k);
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count > this.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }
}
