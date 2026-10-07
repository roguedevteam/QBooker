import { query } from "../db/pool.js";
import { getToday, londonNowMinutes } from "./clock.js";
import { getUpcomingBookableSlots, getBookableSlotsForHour, getHourBlocks, walkInStatusNow, currentHourBlock } from "./scheduling.js";
import { isServiceLicensedOn } from "./serviceLicense.js";
import { isDateString, clockMinutesOrUndefined } from "./validate.js";

// Staffing for a service on one day, mapped by the service's mode. Used by availability, the
// join rules and the Today ribbon so they all agree.
export function dayCfg(service, day) {
  const staffCount = day.staff_count ?? 2;
  const bookingStaffCount = service.mode === "queue" ? 0 : service.mode === "appointment" ? staffCount : (day.booking_staff_count ?? 1);
  const walkInStaffCount = service.mode === "queue" ? staffCount : service.mode === "appointment" ? 0 : (day.walkin_staff_count ?? Math.max(0, staffCount - bookingStaffCount));
  return { slotMinutes: service.slot_minutes, staffCount, bookingStaffCount, walkInStaffCount, hours: day.hours || [] };
}

// Every slot a service offers on a day, regardless of time of day or how full it is.
export function offeredSlots(cfg) {
  const slots = [];
  getHourBlocks(cfg).forEach((b) => slots.push(...getBookableSlotsForHour(cfg, b)));
  return slots;
}

export async function loadService(tenantId, serviceId) {
  const r = await query(
    `select s.*, l.archived as location_archived from services s
     join locations l on l.id = s.location_id
     where s.id=$1 and s.tenant_id=$2`,
    [serviceId, tenantId]
  );
  return r.rows[0] || null;
}

// What a patient (or the staff simulator) sees for one service on one date.
export async function getAvailability(service, date, clockMinutesRaw) {
  if (!isDateString(date)) return { open: false, reason: "outside_license_window" };
  if (service.archived || service.location_archived || !(await isServiceLicensedOn(service.id, date))) {
    return { open: false, reason: "outside_license_window" };
  }
  const today = getToday();
  if (date < today) return { open: false, reason: "closed" };
  if (service.mode === "queue" && service.queue_paused) return { open: false, reason: "paused" };

  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date])).rows[0];
  if (!day || !day.hours?.length) return { open: false, reason: "closed" };

  const nowMins = clockMinutesOrUndefined(clockMinutesRaw) ?? londonNowMinutes();
  // Past the end of the last opening block today (hours are 30-minute start times): closed for
  // the day, not "fully booked". Other days are never filtered by the time of day.
  if (date === today && nowMins >= Math.max(...day.hours) + 30) return { open: false, reason: "closed" };

  const cfg = dayCfg(service, day);
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
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, date === today ? nowMins : 0, 200);
  return { open: true, walkIn, bookableSlots };
}
