// The one place the server asks "what time is it?".
//
// BUSINESS TIME ZONE. "Today" is the calendar date in the time zone of the LOCATION being asked about
// (locations.timezone, an IANA name; Europe/London unless set otherwise), never the UTC date: between 00:00
// and 01:00 British Summer Time the UTC date is still yesterday, and using it put a 00:10 BST patient on
// yesterday's day, made licences end an hour late / start an hour late, and swept tickets an hour late.
// Dates are derived with Intl (IANA tz database), so DST switches need no special-casing: Intl is what knows
// 25 Oct 2026 has a 25-hour day in London and 29 Mar 2026 a 23-hour one. Minutes-since-midnight are WALL-CLOCK
// minutes in that zone (what a clinic's opening hours are written in). Every function that needs a zone takes
// it as an optional last argument defaulting to DEFAULT_TIMEZONE, so the old London-only call sites still work.
//
// TWO SEPARATE OVERRIDES, both off by default:
//  * the System Admin "simulated today" (setSimulatedToday) - replaces only the DATE, a product feature
//    used to demo date-locking; the time of day stays real.
//  * the TEST CLOCK - replaces "now" itself (date AND time of day). It exists only so automated tests can
//    run the server at 23:30Z, 00:30 BST, the DST nights... It is honoured ONLY when NODE_ENV === 'test'
//    or QB_TEST_NOW is set in the environment; otherwise setTestNow() throws and the real clock is used.
//    QB_TEST_NOW=<ISO instant> sets the starting instant; the clock then runs forward in real time from
//    it (so ordering by created_at still works) unless QB_TEST_NOW_FROZEN=1, which freezes it.

export const DEFAULT_TIMEZONE = "Europe/London";
const TZ = DEFAULT_TIMEZONE;

let simulatedToday = null; // 'YYYY-MM-DD' or null
let testBase = null;       // { instant: ms, startedAt: ms, frozen: bool } or null

export function testClockEnabled() {
  return process.env.NODE_ENV === "test" || !!process.env.QB_TEST_NOW;
}

function parseInstant(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    throw new Error("QB_TEST_NOW must be an ISO instant with an offset, e.g. 2026-10-24T23:30:00Z");
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error("QB_TEST_NOW is not a valid instant");
  return ms;
}

export function setTestNow(iso, { frozen = false } = {}) {
  if (!testClockEnabled()) throw new Error("The test clock is disabled (needs NODE_ENV=test or QB_TEST_NOW).");
  testBase = iso === null || iso === undefined ? null : { instant: parseInstant(iso), startedAt: Date.now(), frozen: !!frozen };
}
export function clearTestNow() { testBase = null; }

if (process.env.QB_TEST_NOW) {
  setTestNow(process.env.QB_TEST_NOW, { frozen: process.env.QB_TEST_NOW_FROZEN === "1" });
}

// The current instant as a Date: the test clock when one is set (and enabled), otherwise the real time.
export function now() {
  if (testBase && testClockEnabled()) {
    return new Date(testBase.frozen ? testBase.instant : testBase.instant + (Date.now() - testBase.startedAt));
  }
  return new Date();
}
export function isTestClockActive() { return !!(testBase && testClockEnabled()); }

// For SQL: `coalesce($n::timestamptz, now())`. null normally (the database clock is used), the test
// clock's instant when one is active so timestamps written by the server agree with its idea of today.
export function testNowParam() {
  return isTestClockActive() ? now().toISOString() : null;
}

// --- zone arithmetic ---------------------------------------------------------------------------------
const fmtCache = new Map();
function formatterFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (fmtCache.size > 700) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  return f;
}
function localParts(d, tz = TZ) {
  const p = {};
  for (const x of formatterFor(tz).formatToParts(d)) p[x.type] = x.value;
  return p;
}

// True when Intl knows this zone name (a syntactic + existence check; the API additionally requires the database to know it).
export function isKnownTimezone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { formatterFor(tz); return true; } catch { return false; }
}

// 'YYYY-MM-DD' of an instant in the given zone.
export function localDate(d = now(), tz = TZ) {
  const p = localParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
// Wall-clock minutes since local midnight for an instant in the given zone (the wall clock, so it repeats during a
// clocks-back hour and skips the clocks-forward hour).
export function localMinutes(d = now(), tz = TZ) {
  const p = localParts(d, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}
// Back-compat names (the original London-only API).
export const londonDate = (d = now(), tz = TZ) => localDate(d, tz);
export const londonMinutes = (d = now(), tz = TZ) => localMinutes(d, tz);

// Offset of a zone from UTC, in whole minutes, at an instant (ms).
function offsetMinutesAt(tz, ms) {
  const sec = Math.floor(ms / 1000) * 1000;
  const p = localParts(new Date(sec), tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - sec) / 60000);
}

// The shape of one local calendar day: the wall-clock minute ranges that do NOT exist (the clocks-forward gap) and the
// ones that happen TWICE (the clocks-back repeat), as half-open [from, to) minute-of-day pairs, plus the day's real
// length. London on 29 Mar 2026: gaps [[60,120]], minutes 1380. On 25 Oct 2026: folds [[60,120]], minutes 1500.
// Lord Howe has a 30-minute shift: gaps [[120,150]]. Cached per zone+date (a day's shape never changes).
const shapeCache = new Map();
export function dayShape(tz, dateStr) {
  const key = `${tz}|${dateStr}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const base = Date.parse(`${dateStr}T00:00:00Z`); // local midnight "as if it were UTC"
  const shape = { gaps: [], folds: [], minutes: 1440 };
  if (Number.isFinite(base) && isKnownTimezone(tz)) {
    const from = base - 15 * 3600000, to = base + 39 * 3600000; // covers local midnight..midnight for every zone from UTC-12 to UTC+14
    let prev = offsetMinutesAt(tz, from);
    if (offsetMinutesAt(tz, to) !== prev) {
      // Hourly scan for the step, then bisect to the exact minute. (Two transitions never fall inside one such window.)
      for (let t = from + 3600000; t <= to; t += 3600000) {
        const o = offsetMinutesAt(tz, t);
        if (o !== prev) {
          let a = t - 3600000, b = t; // offset(a) === prev, offset(b) !== prev
          while (b - a > 60000) { const m = Math.floor((a + (b - a) / 2) / 60000) * 60000; if (offsetMinutesAt(tz, m) === prev) a = m; else b = m; }
          const before = prev, after = o, wallAtStep = b + before * 60000; // the wall clock reading just before the step
          const toMin = (ms) => (ms - base) / 60000;
          if (after > before) { // clocks go forward: wall minutes [wallAtStep, wallAtStep + shift) never happen
            const gap = [toMin(wallAtStep), toMin(wallAtStep) + (after - before)];
            if (gap[1] > 0 && gap[0] < 1440) { shape.gaps.push([Math.max(0, gap[0]), Math.min(1440, gap[1])]); shape.minutes -= Math.min(1440, gap[1]) - Math.max(0, gap[0]); }
          } else { // clocks go back: wall minutes [step + after, step + before) happen twice
            const fold = [toMin(b + after * 60000), toMin(b + before * 60000)];
            if (fold[1] > 0 && fold[0] < 1440) { shape.folds.push([Math.max(0, fold[0]), Math.min(1440, fold[1])]); shape.minutes += Math.min(1440, fold[1]) - Math.max(0, fold[0]); }
          }
          prev = o;
        }
      }
    }
  }
  if (shapeCache.size > 20000) shapeCache.clear();
  shapeCache.set(key, shape);
  return shape;
}
// Does this wall-clock minute exist at all on that local day? (False inside a clocks-forward gap.)
export function minuteExists(tz, dateStr, minute) {
  return !dayShape(tz, dateStr).gaps.some(([a, b]) => minute >= a && minute < b);
}
// Does this wall-clock minute happen twice that day (clocks going back)?
export function minuteIsRepeated(tz, dateStr, minute) {
  return dayShape(tz, dateStr).folds.some(([a, b]) => minute >= a && minute < b);
}

// The business's "today" in a zone: a simulated date if System Admin set one (it replaces the date for every zone),
// else that zone's calendar date.
export function getToday(tz = TZ) {
  return simulatedToday || localDate(now(), tz);
}
// The simulated date itself ('YYYY-MM-DD') or null - for SQL that must apply the same override.
export function getSimulatedToday() {
  return simulatedToday;
}
export function isSimulated() {
  return simulatedToday !== null;
}
export function setSimulatedToday(dateStr) {
  simulatedToday = dateStr;
}
export function clearSimulatedToday() {
  simulatedToday = null;
}

// Wall-clock minutes since midnight right now in a zone. This is the ONLY source of "what time is it" for the booking
// rules: client-supplied clock values are never used for them.
export function nowMinutes(tz = TZ) {
  return localMinutes(now(), tz);
}
// Back-compat name (the original London-only API).
export function londonNowMinutes(tz = TZ) {
  return nowMinutes(tz);
}

// SQL fragment for "the current instant": the database clock normally, or a literal for the active test
// clock (built only from an instant this module formatted itself, never from request input).
export function nowSql() {
  return isTestClockActive() ? `'${now().toISOString()}'::timestamptz` : "now()";
}
