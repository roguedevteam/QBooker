import { getToday } from "./clock.js";

// A date "locks" (can't be moved or, for hours, edited) once it has arrived.
// today/date args are 'YYYY-MM-DD' strings or Date objects — compared as calendar dates. `tz` is the IANA zone of the
// location whose calendar is meant (default Europe/London).
function toDateOnly(d) {
  const date = d instanceof Date ? d : new Date(d + "T00:00:00Z");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isDateLocked(dateStr, tz) {
  if (!dateStr) return false;
  const today = toDateOnly(getToday(tz));
  const target = toDateOnly(dateStr);
  return target <= today;
}

// Stricter than isDateLocked: true only for dates that have fully passed (yesterday or
// earlier), not today. Used for hour-editing, where today should stay editable for its
// remaining (not-yet-passed) hours — unlike isDateLocked, which is used for whole-plan
// rescheduling and correctly treats today as already locked for that purpose.
export function isDateFullyPast(dateStr, tz) {
  if (!dateStr) return false;
  const today = toDateOnly(getToday(tz));
  const target = toDateOnly(dateStr);
  return target < today;
}

export function addDays(dateStr, n) {
  const d = toDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
