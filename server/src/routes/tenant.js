import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { genAccessCode, logSimulatedMessage } from "../lib/simulate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";
import {
  getUpcomingBookableSlots, walkInStatusNow, currentHourBlock,
} from "../lib/scheduling.js";
import { isDateLocked, getPlanWindow, isWithinPaidWindow, addDays } from "../lib/plan.js";
import { getToday } from "../lib/clock.js";

const router = Router();

router.use(requireAuth("tenant_admin", "staff"));

async function loadTenant(req, res, next) {
  const result = await query(`select * from tenants where id=$1`, [req.auth.tenantId]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Account not found." });
  req.tenant = result.rows[0];
  next();
}
router.use(asyncHandler(loadTenant));

function adminOnly(req, res, next) {
  if (req.auth.role !== "tenant_admin") return res.status(403).json({ error: "Admin only." });
  next();
}

router.get("/me", (req, res) => res.json({ tenant: req.tenant }));

// --- Plan window & rescheduling ------------------------------------------------
router.get("/plan", (req, res) => {
  const window = getPlanWindow(req.tenant);
  res.json({
    planId: req.tenant.plan_id,
    window,
    locked: window ? isDateLocked(window.start) : true,
  });
});

router.patch("/plan", adminOnly, asyncHandler(async (req, res) => {
  const { activeDate, weekStartDate, startDate } = req.body;
  const tenant = req.tenant;

  if (tenant.plan_id === "day") {
    if (isDateLocked(tenant.active_date)) return res.status(409).json({ error: "This day has already started — it can no longer be rescheduled." });
    if (!activeDate) return res.status(400).json({ error: "activeDate required." });
    const r = await query(`update tenants set active_date=$1 where id=$2 returning *`, [activeDate, tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Day pass rescheduled to ${activeDate}`]);
    return res.json({ tenant: r.rows[0] });
  }
  if (tenant.plan_id === "week") {
    if (isDateLocked(tenant.week_start_date)) return res.status(409).json({ error: "Day 1 has already started — the week can no longer be rescheduled." });
    if (!weekStartDate) return res.status(400).json({ error: "weekStartDate required." });
    const r = await query(`update tenants set week_start_date=$1 where id=$2 returning *`, [weekStartDate, tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Week pass rescheduled to start ${weekStartDate}`]);
    return res.json({ tenant: r.rows[0] });
  }
  if (["month", "year", "custom"].includes(tenant.plan_id)) {
    if (isDateLocked(tenant.start_date)) return res.status(409).json({ error: "Your access start date has already passed — it can no longer be rescheduled." });
    if (!startDate) return res.status(400).json({ error: "startDate required." });
    const newEnd = addDays(startDate, tenant.plan_days - 1);
    const r = await query(`update tenants set start_date=$1, end_date=$2 where id=$3 returning *`, [startDate, newEnd, tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Access start rescheduled to ${startDate}`]);
    return res.json({ tenant: r.rows[0] });
  }
  res.status(400).json({ error: "Unknown plan type." });
}));

// Renew for another full period of the same length, charged at the tenant's existing
// price. Starts the day after the current window ends if it hasn't expired yet, or today
// if it already has — so renewing early never loses paid-for time.
router.post("/plan/extend", adminOnly, asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const today = getToday();

  if (tenant.plan_id === "day") {
    const newDate = tenant.active_date && tenant.active_date >= today ? addDays(tenant.active_date, 1) : today;
    const r = await query(`update tenants set active_date=$1 where id=$2 returning *`, [newDate, tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Plan extended — new day pass for ${newDate}, £${tenant.price} charged`]);
    return res.json({ tenant: r.rows[0] });
  }
  if (tenant.plan_id === "week") {
    const currentEnd = tenant.week_start_date ? addDays(tenant.week_start_date, 6) : null;
    const newStart = currentEnd && currentEnd >= today ? addDays(currentEnd, 1) : today;
    const r = await query(`update tenants set week_start_date=$1 where id=$2 returning *`, [newStart, tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Plan extended — another week from ${newStart}, £${tenant.price} charged`]);
    return res.json({ tenant: r.rows[0] });
  }
  // month / year / custom
  const newStart = tenant.end_date && tenant.end_date >= today ? addDays(tenant.end_date, 1) : today;
  const newEnd = addDays(newStart, tenant.plan_days - 1);
  const r = await query(`update tenants set start_date=$1, end_date=$2 where id=$3 returning *`, [newStart, newEnd, tenant.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenant.id, `Plan extended to ${newEnd} — £${tenant.price} charged`]);
  res.json({ tenant: r.rows[0] });
}));

// --- Locations ---------------------------------------------------------------
router.get("/locations", asyncHandler(async (req, res) => {
  const result = await query(
    `select l.*, lc.code from locations l
     left join location_codes lc on lc.location_id = l.id
     where l.tenant_id=$1 order by l.created_at`,
    [req.tenant.id]
  );
  res.json({ locations: result.rows });
}));

router.post("/locations", adminOnly, asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required." });
  const loc = await query(`insert into locations (tenant_id, name) values ($1,$2) returning *`, [req.tenant.id, name.trim()]);
  const code = await createLocationCode(query, req.tenant.id, loc.rows[0].id);
  await query(`update tenants set location_count = location_count + 1 where id=$1`, [req.tenant.id]);
  const chargeNote = req.tenant.payment_method === "invoice"
    ? `£${req.tenant.price_per_location} added to next invoice`
    : `£${req.tenant.price_per_location} charged to card on file`;
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Bought an additional location "${name.trim()}" — ${chargeNote}`]);
  res.json({ location: { ...loc.rows[0], code }, charge: { amount: req.tenant.price_per_location, note: chargeNote } });
}));

router.patch("/locations/:id", adminOnly, asyncHandler(async (req, res) => {
  const { name, address } = req.body;
  const result = await query(
    `update locations set name=coalesce($1,name), address=coalesce($2,address) where id=$3 and tenant_id=$4 returning *`,
    [name, address, req.params.id, req.tenant.id]
  );
  res.json({ location: result.rows[0] });
}));

router.delete("/locations/:id", adminOnly, asyncHandler(async (req, res) => {
  await query(`delete from locations where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  res.json({ ok: true });
}));

// --- Services ------------------------------------------------------------------
router.get("/services", asyncHandler(async (req, res) => {
  const result = await query(`select * from services where tenant_id=$1 order by created_at`, [req.tenant.id]);
  res.json({ services: result.rows });
}));

router.post("/services", adminOnly, asyncHandler(async (req, res) => {
  const { name, locationId } = req.body;
  if (!name?.trim() || !locationId) return res.status(400).json({ error: "Name and location required." });
  const result = await query(
    `insert into services (tenant_id, location_id, name) values ($1,$2,$3) returning *`,
    [req.tenant.id, locationId, name.trim()]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `Service "${name.trim()}" added`]);
  res.json({ service: result.rows[0] });
}));

router.patch("/services/:id", adminOnly, asyncHandler(async (req, res) => {
  const { name, slotMinutes, mode, queuePaused, queueStaffCount } = req.body;
  const result = await query(
    `update services set
       name = coalesce($1, name),
       slot_minutes = coalesce($2, slot_minutes),
       mode = coalesce($3, mode),
       queue_paused = coalesce($4, queue_paused),
       queue_staff_count = coalesce($5, queue_staff_count)
     where id=$6 and tenant_id=$7 returning *`,
    [name, slotMinutes, mode, queuePaused, queueStaffCount, req.params.id, req.tenant.id]
  );
  res.json({ service: result.rows[0] });
}));

router.delete("/services/:id", adminOnly, asyncHandler(async (req, res) => {
  await query(`delete from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  res.json({ ok: true });
}));

// --- Per-day hours & staffing ----------------------------------------------------
router.get("/services/:id/daily-config", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const result = await query(
    `select * from service_daily_config where service_id=$1 and date >= $2 and date <= $3 order by date`,
    [req.params.id, from, to]
  );
  const window = getPlanWindow(req.tenant);
  res.json({
    dailyConfig: result.rows,
    window,
    lockedFrom: window ? window.start : null,
  });
}));

router.put("/services/:id/daily-config", adminOnly, asyncHandler(async (req, res) => {
  const { date, hours, staffCount, bookingStaffCount } = req.body;
  const window = getPlanWindow(req.tenant);
  if (window && (date < window.start || date > window.end)) {
    return res.status(409).json({ error: "That date is outside your paid access window." });
  }
  if (isDateLocked(date)) return res.status(409).json({ error: "That date has already started, so it's locked." });
  const result = await query(
    `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count)
     values ($1,$2,$3,$4,$5)
     on conflict (service_id, date) do update set
       hours = excluded.hours, staff_count = excluded.staff_count, booking_staff_count = excluded.booking_staff_count
     returning *`,
    [req.params.id, date, hours || [], staffCount ?? 2, bookingStaffCount ?? 1]
  );
  res.json({ dailyConfig: result.rows[0] });
}));

router.post("/services/:id/daily-config/copy", adminOnly, asyncHandler(async (req, res) => {
  const { fromDate, toDates } = req.body;
  const window = getPlanWindow(req.tenant);
  const sourceResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [req.params.id, fromDate]);
  const source = sourceResult.rows[0] || { hours: [], staff_count: 2, booking_staff_count: 1 };
  let applied = 0;
  for (const date of toDates || []) {
    if (isDateLocked(date)) continue;
    if (window && (date < window.start || date > window.end)) continue;
    await query(
      `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count)
       values ($1,$2,$3,$4,$5)
       on conflict (service_id, date) do update set
         hours = excluded.hours, staff_count = excluded.staff_count, booking_staff_count = excluded.booking_staff_count`,
      [req.params.id, date, source.hours, source.staff_count, source.booking_staff_count]
    );
    applied++;
  }
  res.json({ ok: true, count: applied, skipped: (toDates || []).length - applied });
}));

// --- Tickets ----------------------------------------------------------------------
router.get("/tickets", asyncHandler(async (req, res) => {
  const { date } = req.query;
  const result = await query(
    `select * from tickets where tenant_id=$1 and visit_date=$2 order by created_at desc`,
    [req.tenant.id, date || new Date().toISOString().slice(0, 10)]
  );
  res.json({ tickets: result.rows });
}));

router.patch("/tickets/:id", asyncHandler(async (req, res) => {
  const { status, serviceId, locationId, slotTime, type, hourBlock } = req.body;
  const result = await query(
    `update tickets set
       status = coalesce($1, status),
       service_id = coalesce($2, service_id),
       location_id = coalesce($3, location_id),
       slot_time = $4,
       type = coalesce($5, type),
       hour_block = coalesce($6, hour_block)
     where id=$7 and tenant_id=$8 returning *`,
    [status, serviceId, locationId, slotTime, type, hourBlock, req.params.id, req.tenant.id]
  );
  res.json({ ticket: result.rows[0] });
}));

router.delete("/tickets/:id", asyncHandler(async (req, res) => {
  await query(`delete from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  res.json({ ok: true });
}));

router.post("/services/:id/call-next", asyncHandler(async (req, res) => {
  const { date, clockMinutes, roomLabel } = req.body;
  const callable = await query(
    `select * from tickets
     where service_id=$1 and tenant_id=$2 and visit_date=$3
       and ((type='walk_in' and status='waiting') or (type='booked' and status='booked' and slot_time <= $4))
     order by (case when type='booked' then slot_time else extract(epoch from created_at)::int end) asc
     limit 1`,
    [req.params.id, req.tenant.id, date, clockMinutes]
  );
  if (callable.rows.length === 0) return res.status(404).json({ error: "Nobody left to call." });
  const ticket = callable.rows[0];
  await query(`update tickets set status='seen' where id=$1`, [ticket.id]);
  const roomText = roomLabel?.trim() ? `Please come to ${roomLabel.trim()}.` : "No location has been given yet — please check with a member of staff.";
  const body = `It's your turn! ${roomText}`;
  await logSimulatedMessage({ tenantId: req.tenant.id, channel: "whatsapp", toReference: ticket.ticket_number, body });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} called forward — WhatsApp ping sent: "${roomText}"`]);
  res.json({ ticket: { ...ticket, status: "seen" }, message: body });
}));

router.post("/tickets/:id/call-again", asyncHandler(async (req, res) => {
  const { roomLabel } = req.body;
  const ticketResult = await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (ticketResult.rows.length === 0) return res.status(404).json({ error: "Ticket not found." });
  const ticket = ticketResult.rows[0];
  const roomText = roomLabel?.trim() ? `Please come to ${roomLabel.trim()}.` : "No location has been given yet — please check with a member of staff.";
  const body = `It's your turn! ${roomText}`;
  await logSimulatedMessage({ tenantId: req.tenant.id, channel: "whatsapp", toReference: ticket.ticket_number, body });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} called again — WhatsApp ping sent: "${roomText}"`]);
  res.json({ ok: true, message: body });
}));

router.post("/tickets/:id/return-to-queue", asyncHandler(async (req, res) => {
  const { clockMinutes } = req.body;
  const ticketResult = await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (ticketResult.rows.length === 0) return res.status(404).json({ error: "Ticket not found." });
  const ticket = ticketResult.rows[0];
  const service = (await query(`select * from services where id=$1`, [ticket.service_id])).rows[0];
  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [ticket.service_id, ticket.visit_date])).rows[0];
  let hourBlock = ticket.hour_block;
  if (day?.hours?.length) {
    const cfg = { hours: day.hours, slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount: day.booking_staff_count };
    hourBlock = currentHourBlock(cfg, Number(clockMinutes));
  }
  const result = await query(
    `update tickets set status='waiting', type='walk_in', slot_time=null, hour_block=$1 where id=$2 returning *`,
    [hourBlock, ticket.id]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} didn't come forward — returned to the ${service?.name || "service"} queue`]);
  res.json({ ticket: result.rows[0] });
}));

router.post("/tickets/:id/cancel", asyncHandler(async (req, res) => {
  const ticketResult = await query(`update tickets set status='cancelled' where id=$1 and tenant_id=$2 returning *`, [req.params.id, req.tenant.id]);
  if (ticketResult.rows.length === 0) return res.status(404).json({ error: "Ticket not found." });
  const ticket = ticketResult.rows[0];
  const service = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} cancelled — didn't come forward for ${service?.name || "service"}`]);
  res.json({ ticket });
}));

router.post("/tickets/:id/route", asyncHandler(async (req, res) => {
  const { newServiceId, clockMinutes } = req.body;
  const ticketResult = await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (ticketResult.rows.length === 0) return res.status(404).json({ error: "Ticket not found." });
  const ticket = ticketResult.rows[0];
  const oldService = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  const newService = (await query(`select * from services where id=$1 and tenant_id=$2`, [newServiceId, req.tenant.id])).rows[0];
  if (!newService) return res.status(404).json({ error: "Target service not found." });

  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [newServiceId, ticket.visit_date])).rows[0];
  let hourBlock = null;
  if (day?.hours?.length) {
    const cfg = { hours: day.hours, slotMinutes: newService.slot_minutes, staffCount: day.staff_count, bookingStaffCount: day.booking_staff_count };
    hourBlock = currentHourBlock(cfg, Number(clockMinutes));
  }
  const result = await query(
    `update tickets set service_id=$1, location_id=$2, status='waiting', type='walk_in', slot_time=null, hour_block=$3 where id=$4 returning *`,
    [newServiceId, newService.location_id, hourBlock, ticket.id]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} routed from ${oldService?.name || "service"} to ${newService.name}`]);
  res.json({ ticket: result.rows[0] });
}));

router.post("/tickets/:id/close", asyncHandler(async (req, res) => {
  const ticketResult = await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (ticketResult.rows.length === 0) return res.status(404).json({ error: "Ticket not found." });
  const ticket = ticketResult.rows[0];
  const service = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} closed — finished serving for ${service?.name || "service"}`]);
  res.json({ ok: true });
}));

// --- Availability (used by the Customer WhatsApp simulator) -----------------------
router.get("/services/:id/availability", asyncHandler(async (req, res) => {
  const { date, clockMinutes } = req.query;

  if (!isWithinPaidWindow(req.tenant, date)) {
    return res.json({ open: false, reason: "outside_plan_window" });
  }

  const svcResult = await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (svcResult.rows.length === 0) return res.status(404).json({ error: "Service not found." });
  const service = svcResult.rows[0];

  if (service.mode === "queue") {
    if (service.queue_paused) return res.json({ open: false, reason: "paused" });
    const cfg = { slotMinutes: service.slot_minutes, staffCount: service.queue_staff_count, bookingStaffCount: 0, hours: allDayBlocks() };
    const waitingCount = await countWaiting(req.tenant.id, service.id, date);
    const status = walkInStatusNow(cfg, waitingCount, Number(clockMinutes));
    return res.json({ open: true, walkIn: status, bookableSlots: [] });
  }

  const dayResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date]);
  const day = dayResult.rows[0];
  if (!day || !day.hours?.length) return res.json({ open: false, reason: "closed" });

  const bookingStaffCount = service.mode === "appointment" ? day.staff_count : day.booking_staff_count;
  const cfg = { slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount, hours: day.hours };

  const blockCountResult = await query(
    `select hour_block, count(*) from tickets
     where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3 group by hour_block`,
    [service.id, date, currentHourBlock(cfg, Number(clockMinutes))]
  );
  const walkInCountInBlock = Number(blockCountResult.rows[0]?.count || 0);
  const walkIn = walkInStatusNow(cfg, walkInCountInBlock, Number(clockMinutes));

  const bookedResult = await query(
    `select slot_time, count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' group by slot_time`,
    [service.id, date]
  );
  const bookedCountByTime = {};
  bookedResult.rows.forEach((r) => { bookedCountByTime[r.slot_time] = Number(r.count); });
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, Number(clockMinutes), 3);

  res.json({ open: true, walkIn, bookableSlots });
}));

function allDayBlocks() {
  const hours = [];
  for (let h = 0; h < 24 * 60; h += 30) hours.push(h);
  return hours;
}
async function countWaiting(tenantId, serviceId, date) {
  const r = await query(
    `select count(*) from tickets where tenant_id=$1 and service_id=$2 and visit_date=$3 and type='walk_in' and status='waiting'`,
    [tenantId, serviceId, date]
  );
  return Number(r.rows[0]?.count || 0);
}

router.post("/services/:id/tickets", asyncHandler(async (req, res) => {
  const { type, slotTime, hourBlock, date } = req.body;
  if (!isWithinPaidWindow(req.tenant, date)) {
    return res.status(409).json({ error: "We're not taking bookings today — outside the account's paid access window." });
  }
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });

  const countResult = await query(`select count(*) from tickets where service_id=$1 and visit_date=$2`, [service.id, date]);
  const count = Number(countResult.rows[0].count) + 1;
  const initials = (service.name.match(/\b\w/g) || ["S", "V"]).slice(0, 2).join("").toUpperCase();
  const ticketNumber = `${initials}-${String(count).padStart(3, "0")}`;

  const result = await query(
    `insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status, slot_time, hour_block, visit_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [req.tenant.id, service.id, service.location_id, ticketNumber, type, type === "booked" ? "booked" : "waiting", slotTime ?? null, hourBlock ?? null, date]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticketNumber} ${type === "booked" ? `booked ${service.name}` : `joined the ${service.name} queue (walk-in)`}`]);
  res.json({ ticket: result.rows[0] });
}));

// --- Audit log & dashboard ---------------------------------------------------------
router.get("/audit-log", asyncHandler(async (req, res) => {
  const result = await query(`select * from audit_log where tenant_id=$1 order by created_at desc limit 200`, [req.tenant.id]);
  res.json({ auditLog: result.rows });
}));

router.get("/dashboard/stats", asyncHandler(async (req, res) => {
  const { date } = req.query;
  const result = await query(
    `select status, count(*) from tickets where tenant_id=$1 and visit_date=$2 group by status`,
    [req.tenant.id, date || new Date().toISOString().slice(0, 10)]
  );
  const stats = { waiting: 0, booked: 0, seen: 0, no_show: 0, cancelled: 0 };
  result.rows.forEach((r) => { stats[r.status] = Number(r.count); });
  res.json({ stats });
}));

export default router;
