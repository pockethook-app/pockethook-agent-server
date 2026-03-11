/**
 * Simple token-bucket rate limiter.
 *
 * Limits requests per token (Bearer auth) within a sliding window.
 * No external dependencies — uses in-memory Map with periodic cleanup.
 */

interface TokenBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, TokenBucket>();

/** Default: 30 requests per 60-second window */
const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60_000;

let maxRequests = DEFAULT_MAX_REQUESTS;
let windowMs = DEFAULT_WINDOW_MS;

export function configureRateLimit(opts: { maxRequests?: number; windowMs?: number }): void {
  if (opts.maxRequests) maxRequests = opts.maxRequests;
  if (opts.windowMs) windowMs = opts.windowMs;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export function checkRateLimit(token: string): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(token);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(token, bucket);
  }

  bucket.count++;

  if (bucket.count > maxRequests) {
    const retryAfterMs = windowMs - (now - bucket.windowStart);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  return { allowed: true, remaining: maxRequests - bucket.count };
}

// Clean up expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs * 2) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000);
