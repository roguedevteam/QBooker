// Tiny in-memory fixed-window limiter. Per-process only (resets on restart, not shared between
// instances) — fine as a brake on casual abuse, not a substitute for a gateway/WAF limit.
const buckets = new Map();

export function rateLimit({ windowMs, max, keyFn, message = "Too many requests — please wait a moment and try again." }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.baseUrl}${req.route?.path || ""}|${keyFn ? keyFn(req) : req.ip}`;
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) {
      res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60 * 1000).unref();
