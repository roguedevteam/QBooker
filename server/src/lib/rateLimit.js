// Tiny in-memory fixed-window limiter. Per-process only (resets on restart, not shared between
// instances) — fine as a brake on casual abuse, not a substitute for a gateway/WAF limit.
const buckets = new Map();

// Test helper (exposed only where the test clock is enabled): forget all counters.
export function resetRateLimits() { buckets.clear(); }

// Gives back the budget every rateLimit() on this request took. Used when the request failed through no fault of the
// caller (e.g. we could not send their sign-in email), so a flaky provider doesn't lock people out of retrying.
export function refundRateLimits(req) {
  for (const f of req.rateLimitRefunds || []) f();
  req.rateLimitRefunds = [];
}

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
    // Lets a handler give the attempt back when it was our fault, not theirs (see refundRateLimits).
    const windowEnds = b.reset;
    (req.rateLimitRefunds ||= []).push(() => { if (b.reset === windowEnds && b.count > 0) b.count -= 1; });
    next();
  };
}

// Counts only FAILED attempts (e.g. wrong passwords) per client address: once `max` have piled up inside
// the window every further attempt - even a correct one - is answered 429 until the window ends. A
// success clears the address's count, so ordinary use is never throttled.
export function failureLimit({ windowMs, max, message = "Too many failed attempts — please wait a few minutes and try again." }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of hits) if (b.reset <= now) hits.delete(k);
  }, 60 * 1000);
  sweep.unref();
  return {
    guard(req, res, next) {
      const b = hits.get(req.ip);
      if (b && b.reset > Date.now() && b.count >= max) {
        res.set("Retry-After", String(Math.ceil((b.reset - Date.now()) / 1000)));
        return res.status(429).json({ error: message });
      }
      next();
    },
    fail(req) {
      const now = Date.now();
      let b = hits.get(req.ip);
      if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; hits.set(req.ip, b); }
      b.count += 1;
    },
    clear(req) { hits.delete(req.ip); },
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60 * 1000).unref();
