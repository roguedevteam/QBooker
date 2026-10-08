import { api } from "./api.js";

// "Today" and "now" are the clinic's: Europe/London, not the device's time zone and not UTC (between 00:00 and
// 01:00 BST the UTC date is still yesterday). The server says what the instant is (so a phone with a wrong clock
// still agrees with it); this works out London's calendar date and wall-clock minutes from that instant, so
// nothing goes stale when the page stays open past midnight. A System-Admin "simulated" date replaces the date only.
const TZ = "Europe/London";
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
let offsetMs = 0;
let simulated = false;
let simulatedDate = null;

function parts(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
// The server's idea of the current instant in ms (device clock corrected by the offset measured at load).
export const nowMs = () => Date.now() + offsetMs;

export function todayIso() {
  return simulated && simulatedDate ? simulatedDate : parts(nowMs()).date;
}
// Minutes since London midnight, right now.
export function nowMinutes() {
  return parts(nowMs()).minutes;
}
// Minutes since London midnight for a given timestamp (ISO string / Date / ms).
export function londonMinutesAt(at) {
  return parts(new Date(at).getTime()).minutes;
}
export function isSimulatedToday() {
  return simulated;
}
export async function refreshClock() {
  try {
    const r = await api.getClock();
    simulated = !!r.simulated;
    simulatedDate = r.simulated ? r.today : null;
    const serverMs = r.now ? Date.parse(r.now) : NaN;
    offsetMs = Number.isFinite(serverMs) ? serverMs - Date.now() : 0;
  } catch {
    // Server unreachable — keep using the last known offset (0 = the device clock) and London time.
  }
  return todayIso();
}
