import { query } from "../db/pool.js";
import { getToday } from "./clock.js";
import { addDays, isDateFullyPast } from "./plan.js";

export const PLAN_META = {
  day: { label: "Day", days: 1 },
  week: { label: "Week", days: 7 },
  month: { label: "Month", days: 30 },
  year: { label: "Year", days: 365 },
};

const REFUND_WINDOW_DAYS = 90; // ~3 months

export function planPricing(pricingRow) {
  return pricingRow?.value || { day: 25, week: 100, month: 200, year: 600, customDailyRate: 20 };
}

export function resolvePlan(planId, customDays, pricing) {
  const sale = pricing.sale?.active ? pricing.sale : null;
  if (planId === "custom") {
    const planDays = Math.max(1, Number(customDays) || 1);
    return { planId, planLabel: `${planDays}-day custom plan`, planDays, price: (planDays * pricing.customDailyRate).toFixed(2) };
  }
  if (PLAN_META[planId]) {
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
export async function resolveServiceLicenses(serviceId) {
  const today = getToday();
  const result = await query(
    `select * from service_licenses where service_id=$1 order by purchased_at desc`,
    [serviceId]
  );
  const resolved = [];
  for (const lic of result.rows) {
    if (lic.status === "scheduled" || lic.status === "active") {
      if (lic.end_date < today && lic.status !== "expired") {
        const r = await query(`update service_licenses set status='expired' where id=$1 returning *`, [lic.id]);
        resolved.push(r.rows[0]);
        continue;
      }
      // Dates were assigned but no opening hours were ever set across the window: once the
      // start date has arrived (and the dates weren't only assigned today, so same-day set-up
      // still works) the licence goes back to Available with its dates cleared, so it isn't
      // used up by a service that never opened.
      if (lic.start_date <= today && (!lic.scheduled_at || String(lic.scheduled_at.toISOString?.() ?? lic.scheduled_at).slice(0, 10) < today)) {
        const has = await query(
          `select 1 from service_daily_config where service_id=$1 and date >= $2 and date <= $3 and coalesce(array_length(hours,1),0) > 0 limit 1`,
          [lic.service_id, lic.start_date, lic.end_date]
        );
        if (!has.rows.length) {
          const r = await query(`update service_licenses set status='available', start_date=null, end_date=null, scheduled_at=null where id=$1 returning *`, [lic.id]);
          await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
            [lic.tenant_id, `Licence returned to Available — no hours were set for its dates (${lic.start_date} to ${lic.end_date})`]);
          resolved.push(r.rows[0]);
          continue;
        }
      }
      if (lic.status === "scheduled" && lic.start_date <= today) {
        const r = await query(`update service_licenses set status='active' where id=$1 returning *`, [lic.id]);
        resolved.push(r.rows[0]);
        continue;
      }
    }
    resolved.push(lic);
  }
  return resolved;
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

export async function isServiceLicensedOn(serviceId, dateStr) {
  const licenses = await resolveServiceLicenses(serviceId);
  return activeAndScheduledWindows(licenses).some((w) => dateStr >= w.start && dateStr <= w.end);
}

export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// Returns { ok: true } if scheduling `start`..`end` on this service is safe — i.e. it
// doesn't land entirely in the past and doesn't overlap another of the service's own
// scheduled/active licenses — or { ok: false, error } with a message fit to show the user.
export async function checkSchedulable(serviceId, start, end, excludeLicenseId) {
  if (isDateFullyPast(end)) {
    return { ok: false, error: "That window has already passed." };
  }
  const licenses = await resolveServiceLicenses(serviceId);
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
  return new Date() <= cutoff;
}
