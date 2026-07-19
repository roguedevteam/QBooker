import { getToday } from "./clock.js";

// A date "locks" (can't be moved or, for hours, edited) once it has arrived.
// today/date args are 'YYYY-MM-DD' strings or Date objects — compared as calendar dates.
function toDateOnly(d) {
  const date = d instanceof Date ? d : new Date(d + "T00:00:00Z");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isDateLocked(dateStr) {
  if (!dateStr) return false;
  const today = toDateOnly(getToday());
  const target = toDateOnly(dateStr);
  return target <= today;
}

// Returns { start, end } (both 'YYYY-MM-DD') for the tenant's current access window, or null.
export function getPlanWindow(tenant) {
  if (tenant.plan_id === "day") return tenant.active_date ? { start: tenant.active_date, end: tenant.active_date } : null;
  if (tenant.plan_id === "week") {
    if (!tenant.week_start_date) return null;
    const start = toDateOnly(tenant.week_start_date);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start: tenant.week_start_date, end: end.toISOString().slice(0, 10) };
  }
  if (["month", "year", "custom"].includes(tenant.plan_id)) {
    return tenant.start_date && tenant.end_date ? { start: tenant.start_date, end: tenant.end_date } : null;
  }
  return null;
}

export function isWithinPaidWindow(tenant, dateStr) {
  const window = getPlanWindow(tenant);
  if (!window) return false;
  return dateStr >= window.start && dateStr <= window.end;
}

export function addDays(dateStr, n) {
  const d = toDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
