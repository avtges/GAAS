/**
 * In-memory token bucket. Adequate for a single-instance MVP; on multi-instance
 * deployments limits are per instance (documented limitation).
 */
type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, opts: { capacity: number; refillPerSecond: number }): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: opts.capacity, updatedAt: now };
  const elapsed = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSecond);
  b.updatedAt = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { ok: true, retryAfterSeconds: 0 };
  }
  buckets.set(key, b);
  return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / opts.refillPerSecond) };
}

export function resetRateLimits(): void {
  buckets.clear();
}
