import { query } from "../db/pool.js";
import { getToday, getSimulatedToday, localDate, now, testNowParam, DEFAULT_TIMEZONE } from "./clock.js";
import { addDays, isDateFullyPast } from "./plan.js";
import { badRequest } from "./validate.js";

export const PLAN_META = {
  day: { label: "Day", days: 1 },
  week: { label: "Week", days: 7 },
  month: { label: "Month", days: 30 },
  year: { label: "Year", days: 365 },
};

const REFUND_WINDOW_DAYS = 90; // ~3 months

export const DEFAULT_PRICES = { day: 25, week: 100, month: 200, year: 600, customDailyRate: 20 };
const PRICE_KEYS = Object.keys(DEFAULT_PRICES);

// The price table in force: whatever the platform admin saved, with the built-in default standing
// in for any price that is missing or not a usable number (e.g. a row saved by an older, laxer
// version of the pricing form) so a customer can never be quoted or charged "undefined" / NaN.
export function effectivePricing(stored) {
  const v = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = {};
  for (const k of PRICE_KEYS) out[k] = typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= 0 ? v[k] : DEFAULT_PRICES[k];
  out.sale = v.sale && typeof v.sale === "object" && !Array.isArray(v.sale) ? v.sale : { active: false };
  return out;
}

// Platform-wide billing display settings (platform_settings 'billing'): the currency the list prices are quoted in (an ISO 4217
// code), and the VAT/sales-tax rate (a fraction, 0.2 = 20%) and what it is called. Prices are stored ex-tax and are NOT converted
// between currencies - a currency here is a label for the numbers in plan_prices. Defaults are the UK values.
export const DEFAULT_BILLING = { currency: "GBP", vatRate: 0.2, vatLabel: "VAT" };
export function effectiveBilling(stored) {
  const v = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  return {
    currency: typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? v.currency : DEFAULT_BILLING.currency,
    vatRate: typeof v.vatRate === "number" && Number.isFinite(v.vatRate) && v.vatRate >= 0 && v.vatRate <= 1 ? v.vatRate : DEFAULT_BILLING.vatRate,
    vatLabel: typeof v.vatLabel === "string" && v.vatLabel.trim() && v.vatLabel.length <= 20 ? v.vatLabel.trim() : DEFAULT_BILLING.vatLabel,
  };
}

export function planPricing(pricingRow) {
  return effectivePricing(pricingRow?.value);
}

export const MAX_CUSTOM_DAYS = 365;

export function resolvePlan(planId, customDays, pricing) {
  if (typeof planId !== "string") return null;
  const sale = pricing.sale?.active ? pricing.sale : null;
  if (planId === "custom") {
    const n = typeof customDays === "string" && /^\d{1,5}$/.test(customDays.trim()) ? Number(customDays) : customDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_CUSTOM_DAYS) {
      throw badRequest(`A custom plan must be a whole number of days between 1 and ${MAX_CUSTOM_DAYS}.`);
    }
    const planDays = n;
    return { planId, planLabel: `${planDays}-day custom plan`, planDays, price: (planDays * pricing.customDailyRate).toFixed(2) };
  }
  // Own properties only: "constructor", "__proto__", "toString" etc. must not resolve to a plan.
  if (Object.prototype.hasOwnProperty.call(PLAN_META, planId)) {
    const planDays = PLAN_META[planId].days;
    const price = sale && sale[planId] != null ? sale[planId] : pricing[planId];
    return { planId, planLabel: PLAN_META[planId].label, planDays, price };
  }
  return null;
}

// A license is one of: Available (bought, no dates, movable to another service),
// Scheduled (dates assigned, may be in the future, locked to this service), Active (today
// falls within its window), Expired (window has fully passed), or Refunded. Scheduled/Active
// are pure date comparisons — unlike the old location-level model, dates are chosen
// explicitly by an admin, never auto-assigned, so there's no "wait for opening hours" step.
// Called on every read that needs an accurate status, since there's no background job.
// The calendar day (in the service's location time zone) a licence's dates were assigned on (scheduled_at is a timestamptz).
function scheduledOn(ts, tz) {
  return localDate(ts instanceof Date ? ts : new Date(ts), tz);
}

// The time zone of the location a service belongs to (its licences run on that location's calendar).
export async function serviceTimezone(serviceId, db = query) {
  const r = await db(`select l.timezone from services s join locations l on l.id = s.location_id where s.id=$1`, [serviceId]);
  return r.rows[0]?.timezone || DEFAULT_TIMEZONE;
}

// Brings every scheduled/active licence of a service up to date for "today" in the service's LOCATION time zone, and
// returns all of the service's licences. The status written in the database is only ever a cache of this; every path
// that reads licence status goes through here (or sweepLicences below, which calls it on a timer), so the answer never
// depends on who happened to look first. Rules, in order, for a scheduled/active licence:
//   1. Window over (end date before today): Expired.
//   2. Dates assigned but no opening hours set anywhere in the window, and the start date has arrived (the dates were
//      not only assigned today, so same-day set-up still works): back to Available, dates cleared, so it is not used up
//      by a service that never opened.
//   3. Scheduled and the start date has arrived: Active.
// Because the sweep (index.js) and every reader call this, rule 2 fires on the first day it applies, whoever looks first;
// a window that was never resolved at all until it was over is simply Expired.
// `tz` may be passed when the caller already knows it (saves a query).
export async function resolveServiceLicenses(serviceId, db = query, tz) {
  const result = await db(
    `select sl.*, l.timezone as _tz from service_licenses sl
       join services s on s.id = sl.service_id join locations l on l.id = s.location_id
      where sl.service_id=$1 order by sl.purchased_at desc`,
    [serviceId]
  );
  const zone = tz || result.rows[0]?._tz || DEFAULT_TIMEZONE;
  const today = getToday(zone);
  const resolved = [];
  for (const row of result.rows) {
    const { _tz, ...lic } = row;
    if (lic.status === "scheduled" || lic.status === "active") {
      if (lic.end_date < today && lic.status !== "expired") {
        const r = await db(`update service_licenses set status='expired' where id=$1 returning *`, [lic.id]);
        resolved.push(r.rows[0]);
        continue;
      }
      if (lic.start_date <= today && (!lic.scheduled_at || scheduledOn(lic.scheduled_at, zone) < today)) {
        const has = await db(
          `select 1 from service_daily_config where service_id=$1 and date >= $2 and date <= $3 and coalesce(array_length(hours,1),0) > 0 limit 1`,
          [lic.service_id, lic.start_date, lic.end_date]
        );
        if (!has.rows.length) {
          const r = await db(`update service_licenses set status='available', start_date=null, end_date=null, scheduled_at=null where id=$1 returning *`, [lic.id]);
          await db(`insert into audit_log (tenant_id, message) values ($1,$2)`,
            [lic.tenant_id, `Licence returned to Available — no hours were set for its dates (${lic.start_date} to ${lic.end_date})`]);
          resolved.push(r.rows[0]);
          continue;
        }
      }
      if (lic.status === "scheduled" && lic.start_date <= today) {
        const r = await db(`update service_licenses set status='active' where id=$1 returning *`, [lic.id]);
        resolved.push(r.rows[0]);
        continue;
      }
    }
    resolved.push(lic);
  }
  return resolved;
}

// A cheap periodic sweep so statuses never go stale just because nobody opened a screen: finds the services whose
// scheduled/active licences might need a change (judged in each location's own time zone, with the System Admin
// simulated date honoured) and resolves them. Safe to run often and from several instances: every change is an
// idempotent conditional update. Returns how many licences changed status.
export async function sweepLicences() {
  const testNow = testNowParam();
  const due = await query(
    `select distinct sl.service_id
       from service_licenses sl
       join services s on s.id = sl.service_id
       join locations l on l.id = s.location_id
      cross join lateral (select coalesce($2::date, (coalesce($1::timestamptz, now()) at time zone l.timezone)::date) as today) d
      where sl.status in ('scheduled','active')
        and ((sl.status = 'scheduled' and sl.start_date <= d.today)
          or sl.end_date < d.today
          or (sl.start_date <= d.today and (sl.scheduled_at is null or (sl.scheduled_at at time zone l.timezone)::date < d.today)
              and not exists (select 1 from service_daily_config c where c.service_id = sl.service_id and c.date >= sl.start_date and c.date <= sl.end_date and coalesce(array_length(c.hours,1),0) > 0)))`,
    [testNow, getSimulatedToday()]
  );
  let changed = 0;
  for (const { service_id } of due.rows) {
    const before = (await query(`select id, status from service_licenses where service_id=$1`, [service_id])).rows;
    const after = await resolveServiceLicenses(service_id);
    const was = new Map(before.map((r) => [r.id, r.status]));
    changed += after.filter((l) => was.get(l.id) !== l.status).length;
  }
  return changed;
}

export async function resolveServiceLicense(id) {
  const result = await query(`select * from service_licenses where id=$1`, [id]);
  if (!result.rows[0]) return null;
  const all = await resolveServiceLicenses(result.rows[0].service_id);
  return all.find((l) => l.id === id) || null;
}

// Every scheduled/active window currently covering (or upcoming for) a service — gaps
// between windows are fine, but the caller must ensure no two windows ever overlap.
export function activeAndScheduledWindows(licenses) {
  return licenses
    .filter((l) => l.status === "scheduled" || l.status === "active")
    .map((l) => ({ start: l.start_date, end: l.end_date, status: l.status }));
}

export async function isServiceLicensedOn(serviceId, dateStr, tz) {
  const licenses = await resolveServiceLicenses(serviceId, query, tz);
  return activeAndScheduledWindows(licenses).some((w) => dateStr >= w.start && dateStr <= w.end);
}

export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// Returns { ok: true } if scheduling `start`..`end` on this service is safe — i.e. it
// doesn't land entirely in the past and doesn't overlap another of the service's own
// scheduled/active licenses — or { ok: false, error } with a message fit to show the user.
// `db` is the query function to use (a transaction client's bound query when called under a lock).
export async function checkSchedulable(serviceId, start, end, excludeLicenseId, db = query, tz) {
  const zone = tz || await serviceTimezone(serviceId, db);
  if (isDateFullyPast(end, zone)) {
    return { ok: false, error: "That window has already passed." };
  }
  // A window that began before today would be bought, then partly used up before it could ever be served.
  if (isDateFullyPast(start, zone)) {
    return { ok: false, error: "That start date has already passed — pick today or a later date." };
  }
  const licenses = await resolveServiceLicenses(serviceId, db, zone);
  const conflict = activeAndScheduledWindows(
    licenses.filter((l) => l.id !== excludeLicenseId)
  ).find((w) => windowsOverlap(start, end, w.start, w.end));
  if (conflict) {
    return { ok: false, error: `${start} to ${end} overlaps an existing license on this service (${conflict.start} to ${conflict.end}) — pick a different start date.` };
  }
  return { ok: true };
}

export function computeEndDate(startDate, planDays) {
  return addDays(startDate, planDays - 1);
}

export function isWithinRefundWindow(license) {
  const purchasedAt = new Date(license.purchased_at);
  const cutoff = new Date(purchasedAt.getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return now() <= cutoff;
}
