import geoip from "geoip-lite";

// Best-effort, offline lookup (bundled database — no outbound call, so it works the same in
// every environment and never blocks signup if it can't resolve something). Returns a
// 2-letter ISO country code, or null for anything it can't place (localhost, private ranges,
// a bad/missing header).
export function countryForIp(ip) {
  if (!ip) return null;
  const cleaned = ip.replace("::ffff:", "").split(",")[0].trim();
  const geo = geoip.lookup(cleaned);
  return geo?.country || null;
}
