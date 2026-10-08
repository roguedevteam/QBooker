// Best-effort, offline lookup (bundled database — no outbound call, so it works the same in
// every environment and never blocks signup if it can't resolve something). Returns a
// 2-letter ISO country code, or null for anything it can't place (localhost, private ranges,
// a bad/missing header). geoip-lite 2.x declares Node >= 24; it loads fine on 22, but the import is
// lazy and guarded so that, whatever happens to it, the server still starts and sign-up still works.
let geoip; // undefined = not tried yet, null = unavailable
async function load() {
  if (geoip !== undefined) return geoip;
  try { geoip = (await import("geoip-lite")).default; }
  catch (err) { geoip = null; console.warn(`[geo] country lookup unavailable: ${err?.code || err?.name || "error"}`); }
  return geoip;
}

export async function countryForIp(ip) {
  if (!ip) return null;
  const geo = await load();
  if (!geo) return null;
  const cleaned = ip.replace("::ffff:", "").split(",")[0].trim();
  try { return geo.lookup(cleaned)?.country || null; } catch { return null; }
}
