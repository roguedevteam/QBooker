// Small shared helpers for the staff kiosk.
export function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
export function formatClock(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
export function formatTime(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}
// "4:20" or "1:04:20"
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
export function minutesSince(iso, nowMs) {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 60000));
}

// Things remembered on this device only (room, services). Never throws.
export function loadPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function savePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// Plain-language version of an error from the API.
export function plainError(err, fallback) {
  const m = err?.message || "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return "We couldn't reach QBooker. Check your internet connection and try again.";
  return m || fallback;
}
