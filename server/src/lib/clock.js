// The one place the server asks "what time is it?".
//
// BUSINESS TIME ZONE. Every clinic is in the UK, so "today" means the Europe/London calendar date, not
// the UTC date: between 00:00 and 01:00 British Summer Time the UTC date is still yesterday, and using it
// put a 00:10 BST patient on yesterday's day, made licences end an hour late / start an hour late, and
// swept tickets an hour late. Dates are derived with Intl (IANA tz database), so the BST/GMT switches
// need no special-casing: Intl is what knows 25 Oct 2026 has a 25-hour day and 29 Mar 2026 a 23-hour one.
// Minutes-since-midnight are WALL-CLOCK minutes in London (what a clinic's opening hours are written in).
//
// TWO SEPARATE OVERRIDES, both off by default:
//  * the System Admin "simulated today" (setSimulatedToday) - replaces only the DATE, a product feature
//    used to demo date-locking; the time of day stays real.
//  * the TEST CLOCK - replaces "now" itself (date AND time of day). It exists only so automated tests can
//    run the server at 23:30Z, 00:30 BST, the DST nights... It is honoured ONLY when NODE_ENV === 'test'
//    or QB_TEST_NOW is set in the environment; otherwise setTestNow() throws and the real clock is used.
//    QB_TEST_NOW=<ISO instant> sets the starting instant; the clock then runs forward in real time from
//    it (so ordering by created_at still works) unless QB_TEST_NOW_FROZEN=1, which freezes it.

const TZ = "Europe/London";

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

const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function londonParts(d) {
  const p = {};
  for (const x of dateFmt.formatToParts(d)) p[x.type] = x.value;
  return p;
}

// 'YYYY-MM-DD' of an instant in London.
export function londonDate(d = now()) {
  const p = londonParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// Wall-clock minutes since London midnight for an instant.
export function londonMinutes(d = now()) {
  const p = londonParts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

// The business's "today": a simulated date if System Admin set one, else the London calendar date.
export function getToday() {
  return simulatedToday || londonDate(now());
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

// Minutes since midnight in the UK, used when a client doesn't say what time it is.
export function londonNowMinutes() {
  return londonMinutes(now());
}

// SQL fragment for "the current instant": the database clock normally, or a literal for the active test
// clock (built only from an instant this module formatted itself, never from request input).
export function nowSql() {
  return isTestClockActive() ? `'${now().toISOString()}'::timestamptz` : "now()";
}
