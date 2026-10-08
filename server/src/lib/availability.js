import { query } from "../db/pool.js";
import { getToday, nowMinutes, dayShape, DEFAULT_TIMEZONE } from "./clock.js";
import { getUpcomingBookableSlots, getBookableSlotsForHour, getHourBlocks, walkInStatusNow, currentHourBlock, inGap } from "./scheduling.js";
import { isServiceLicensedOn } from "./serviceLicense.js";
import { isDateString } from "./validate.js";

// The time zone a service runs on: its LOCATION's (services are loaded joined to locations as `timezone`).
export const serviceTz = (service) => service?.timezone || DEFAULT_TIMEZONE;

// "Now" for a service, always from the SERVER clock in the location's zone. Nothing a client sends is used for the booking
// rules (front-ends may still send clockMinutes; it is accepted and ignored).
export function serviceNow(service) {
  const tz = serviceTz(service);
  return { tz, today: getToday(tz), minutes: nowMinutes(tz) };
}

// Staffing for a service on one day, mapped by the service's mode. Used by availability, the
// join rules and the Today ribbon so they all agree.
// Opening hours are WALL-CLOCK times, so on the day the clocks go forward (a 23-hour day) a stored block that falls in the
// skipped hour does not exist and is dropped here (cfg.gaps lets slots inside a block be dropped too); on the day they go
// back, the repeated hour is one set of blocks, not two (cfg.folds is informational). cfg.dayMinutes is the day's real length.
export function dayCfg(service, day, tz = serviceTz(service)) {
  const staffCount = day.staff_count ?? 2;
  const bookingStaffCount = service.mode === "queue" ? 0 : service.mode === "appointment" ? staffCount : (day.booking_staff_count ?? 1);
  const walkInStaffCount = service.mode === "queue" ? staffCount : service.mode === "appointment" ? 0 : (day.walkin_staff_count ?? Math.max(0, staffCount - bookingStaffCount));
  const date = day.date ? String(day.date).slice(0, 10) : null;
  const shape = date ? dayShape(tz, date) : { gaps: [], folds: [], minutes: 1440 };
  const hours = (day.hours || []).filter((h) => !inGap(shape, h));
  return { slotMinutes: service.slot_minutes, staffCount, bookingStaffCount, walkInStaffCount, hours, gaps: shape.gaps, folds: shape.folds, dayMinutes: shape.minutes };
}

// Every slot a service offers on a day, regardless of time of day or how full it is.
export function offeredSlots(cfg) {
  const slots = [];
  getHourBlocks(cfg).forEach((b) => slots.push(...getBookableSlotsForHour(cfg, b)));
  return slots;
}

export async function loadService(tenantId, serviceId) {
  const r = await query(
    `select s.*, l.archived as location_archived, l.timezone from services s
     join locations l on l.id = s.location_id
     where s.id=$1 and s.tenant_id=$2`,
    [serviceId, tenantId]
  );
  return r.rows[0] || null;
}

// What a patient (or the staff simulator) sees for one service on one date. `_clientClockIgnored` is the legacy
// clockMinutes query parameter: still accepted so already-deployed front-ends keep working, never used.
export async function getAvailability(service, date, _clientClockIgnored) {
  const { tz, today, minutes } = serviceNow(service);
  const r = await availabilityFor(service, date, tz, today, minutes);
  return { ...r, timezone: tz, today, nowMinutes: minutes };
}

async function availabilityFor(service, date, tz, today, nowMins) {
  if (!isDateString(date)) return { open: false, reason: "outside_license_window" };
  if (service.archived || service.location_archived || !(await isServiceLicensedOn(service.id, date, tz))) {
    return { open: false, reason: "outside_license_window" };
  }
  if (date < today) return { open: false, reason: "closed" };
  if (service.mode === "queue" && service.queue_paused) return { open: false, reason: "paused" };

  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date])).rows[0];
  if (!day || !day.hours?.length) return { open: false, reason: "closed" };

  const cfg = dayCfg(service, day, tz);
  if (!cfg.hours.length) return { open: false, reason: "closed" };
  // Past the end of the last opening block today (hours are 30-minute start times): closed for
  // the day, not "fully booked". Other days are never filtered by the time of day.
  if (date === today && nowMins >= Math.max(...cfg.hours) + 30) return { open: false, reason: "closed" };

  const blockCount = (await query(
    `select count(*) from tickets
     where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3`,
    [service.id, date, currentHourBlock(cfg, nowMins)]
  )).rows[0];
  const walkIn = walkInStatusNow(cfg, Number(blockCount?.count || 0), nowMins);
  if (service.mode === "queue") return { open: true, walkIn, bookableSlots: [] };

  const booked = (await query(
    `select slot_time, count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' group by slot_time`,
    [service.id, date]
  )).rows;
  const bookedCountByTime = {};
  booked.forEach((r) => { bookedCountByTime[r.slot_time] = Number(r.count); });
  // A slot can be booked until its own start minute; earlier ones today are gone.
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, date === today ? nowMins : 0, 200);
  return { open: true, walkIn, bookableSlots };
}
