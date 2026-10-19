'use strict';

/**
 * Minimal fixed-window, per-key rate limiter (no dependencies).
 * In-memory => limits are per pod. That is enough to blunt abuse of a demo app;
 * use the load balancer / Cloud Armor for global limits.
 */
function createRateLimiter({ windowMs = 60_000, max = 600, maxKeys = 10_000, now = Date.now } = {}) {
  const buckets = new Map();

  const prune = setInterval(() => {
    const t = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= t) buckets.delete(key);
  }, windowMs);
  prune.unref();

  function middleware(req, res, next) {
    const t = now();
    const key = req.ip || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size >= maxKeys) buckets.clear(); // bound memory under a flood of distinct keys
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'too many requests' });
    }
    next();
  }

  middleware.stop = () => clearInterval(prune);
  return middleware;
}

module.exports = { createRateLimiter };
