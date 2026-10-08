import { api } from "./api.js";

// "Today" and "now" are the clinic's, not the device's time zone and not UTC (between 00:00 and 01:00 BST the UTC
// date is still yesterday). Every location has its own IANA time zone (the API sends it as `timezone` on locations,
// services and tickets); pass it to todayIso()/nowMinutes(). With no argument the account's default zone is used
// (setDefaultTimezone, called once the account is loaded), which is Europe/London until an account says otherwise.
// The server says what the instant is (so a phone with a wrong clock still agrees with it); this works out the
// zone's calendar date and wall-clock minutes from that instant, so nothing goes stale when the page stays open
// past midnight. A System-Admin "simulated" date replaces the date only. The server never trusts these minutes:
// they only drive what the screen shows.
export const FALLBACK_TIMEZONE = "Europe/London";
let defaultTz = FALLBACK_TIMEZONE;
let offsetMs = 0;
let simulated = false;
let simulatedDate = null;

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      f = tz === FALLBACK_TIMEZONE ? null : formatterFor(FALLBACK_TIMEZONE); // unknown zone name: show the fallback rather than crash
    }
    formatters.set(tz, f);
  }
  return f;
}
function parts(ms, tz) {
  const p = {};
  for (const x of formatterFor(tz || defaultTz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
export function setDefaultTimezone(tz) {
  if (typeof tz === "string" && tz && formatterFor(tz)) defaultTz = tz;
}
export const getDefaultTimezone = () => defaultTz;
// The server's idea of the current instant in ms (device clock corrected by the offset measured at load).
export const nowMs = () => Date.now() + offsetMs;

export function todayIso(tz) {
  return simulated && simulatedDate ? simulatedDate : parts(nowMs(), tz).date;
}
// Minutes since local midnight in the zone, right now.
export function nowMinutes(tz) {
  return parts(nowMs(), tz).minutes;
}
// Minutes since local midnight in the zone for a given timestamp (ISO string / Date / ms).
export function zoneMinutesAt(at, tz) {
  return parts(new Date(at).getTime(), tz).minutes;
}
export const londonMinutesAt = zoneMinutesAt; // old name
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
    // Server unreachable - keep using the last known offset (0 = the device clock) and the default zone.
  }
  return todayIso();
}
