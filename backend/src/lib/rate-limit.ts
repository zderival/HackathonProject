// Fixed-window in-memory rate limiter (single instance). Keys expire with their window.
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.max) return false;
    w.count++;
    return true;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
