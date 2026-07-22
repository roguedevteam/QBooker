import { query } from "../db/pool.js";
import { getToday } from "./clock.js";
import { addDays } from "./plan.js";

// Once a location has start_date/end_date, that's its resolved window — no day/week special
// casing needed anymore, since every plan type resolves to the same start+end pair once live.
export function getLocationWindow(location) {
  return location.start_date && location.end_date ? { start: location.start_date, end: location.end_date } : null;
}

export function isLocationWithinWindow(location, dateStr) {
  const window = getLocationWindow(location);
  if (!window) return false;
  return dateStr >= window.start && dateStr <= window.end;
}

// A location's license is one of: no license, "Purchased" (plan set, no dates yet), "Live"
// (dates resolved, today within them), or "Expired" (dates resolved, today past them).
// This checks whether a Purchased license should resolve right now — i.e. whether the
// earliest opening-hour block defined for any service at this location (on or after the
// license's "not before" floor) has actually been reached — and if so, writes its start/end
// dates once, permanently. Called on every read that needs an accurate status, since there's
// no background job driving this; it's evaluated lazily whenever something asks.
export async function ensureLicenseStarted(location) {
  if (!location.plan_id || location.start_date) return location; // no license, or already resolved

  const floor = location.license_not_before || getToday();
  const result = await query(
    `select sdc.date, min(h) as earliest_minute
     from service_daily_config sdc
     join services s on s.id = sdc.service_id
     cross join lateral unnest(sdc.hours) as h
     where s.location_id = $1 and sdc.date >= $2
     group by sdc.date
     order by sdc.date asc
     limit 1`,
    [location.id, floor]
  );
  if (result.rows.length === 0) return location; // nothing defined yet — still dormant

  const earliestDate = result.rows[0].date;
  const earliestMinute = Number(result.rows[0].earliest_minute);
  const today = getToday();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const reached = earliestDate < today || (earliestDate === today && earliestMinute <= nowMinutes);
  if (!reached) return location;

  const startDate = today;
  const endDate = addDays(startDate, location.plan_days - 1);

  const updated = await query(
    `update locations set start_date=$1, end_date=$2 where id=$3 returning *`,
    [startDate, endDate, location.id]
  );
  await query(
    `update location_license_purchases set start_date=$1, end_date=$2
     where id = (select id from location_license_purchases where location_id=$3 and start_date is null order by purchased_at desc limit 1)`,
    [startDate, endDate, location.id]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [location.tenant_id, `License for "${location.name}" started — ${location.plan_label}, live until ${endDate}`]);

  return updated.rows[0];
}
