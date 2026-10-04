import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { genAccessCode, logSimulatedMessage } from "../lib/simulate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";
import {
  getUpcomingBookableSlots, walkInStatusNow, currentHourBlock,
} from "../lib/scheduling.js";
import { isDateFullyPast, addDays } from "../lib/plan.js";
import { getToday } from "../lib/clock.js";
import {
  resolveServiceLicenses, resolveServiceLicense, activeAndScheduledWindows,
  isServiceLicensedOn, checkSchedulable, computeEndDate, isWithinRefundWindow,
  planPricing, resolvePlan,
} from "../lib/serviceLicense.js";

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

router.get("/me", (req, res) => res.json({ tenant: req.tenant, staffLocationId: req.auth.role === "staff" ? req.auth.locationId : null }));

// --- Locations — free, unlimited; a routing + staff-access concept only -------------
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
  const { name, address } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required." });
  const t = req.tenant;
  const staffAccessCode = genAccessCode();
  const loc = await query(
    `insert into locations (tenant_id, name, address, staff_access_code) values ($1,$2,$3,$4) returning *`,
    [t.id, name.trim(), address || "", staffAccessCode]
  );
  const code = await createLocationCode(query, req.tenant.id, loc.rows[0].id);
  await query(`update tenants set location_count = location_count + 1 where id=$1`, [req.tenant.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Location "${name.trim()}" added`]);
  res.json({ location: { ...loc.rows[0], code } });
}));

router.patch("/locations/:id", adminOnly, asyncHandler(async (req, res) => {
  const { name, address, websiteUrl } = req.body;
  const result = await query(
    `update locations set name=coalesce($1,name), address=coalesce($2,address), website_url=coalesce($3,website_url) where id=$4 and tenant_id=$5 returning *`,
    [name, address, websiteUrl, req.params.id, req.tenant.id]
  );
  res.json({ location: result.rows[0] });
}));

router.delete("/locations/:id", adminOnly, asyncHandler(async (req, res) => {
  await query(`delete from locations where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  res.json({ ok: true });
}));

// --- Services --------------------------------------------------------------------
// A service's location, name, mode and slot length are fixed the moment it's created
// (delete-and-recreate is the escape hatch) — staff access, customer routing and ticket
// history all depend on that staying put. Archiving just hides a service from the default
// list and from customers; it never touches its licenses.
router.get("/services", asyncHandler(async (req, res) => {
  const { includeArchived } = req.query;
  const result = await query(
    includeArchived === "true"
      ? `select * from services where tenant_id=$1 order by created_at`
      : `select * from services where tenant_id=$1 and archived=false order by created_at`,
    [req.tenant.id]
  );
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
  const { name, slotMinutes, mode, queuePaused, queueStaffCount, archived } = req.body;
  const existing = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Service not found." });
  const result = await query(
    `update services set
       name = coalesce($1, name),
       slot_minutes = coalesce($2, slot_minutes),
       mode = coalesce($3, mode),
       queue_paused = coalesce($4, queue_paused),
       queue_staff_count = coalesce($5, queue_staff_count),
       archived = coalesce($6, archived)
     where id=$7 and tenant_id=$8 returning *`,
    [name, slotMinutes, mode, queuePaused, queueStaffCount, archived, req.params.id, req.tenant.id]
  );
  if (typeof archived === "boolean" && archived !== existing.archived) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `Service "${existing.name}" ${archived ? "archived" : "unarchived"}`]);
  }
  res.json({ service: result.rows[0] });
}));

router.delete("/services/:id", adminOnly, asyncHandler(async (req, res) => {
  await query(`delete from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  res.json({ ok: true });
}));

// --- Service licenses --------------------------------------------------------------
// Lifecycle: Available (bought, bound to this service, no dates — movable to another
// service) -> Scheduled (dates assigned, locked to this service — movable only to other
// dates) -> Active (today falls within the window) -> Expired. Available licenses can also
// be Refunded, within 90 days of purchase. One license can ever cover a given calendar day
// on a service — never zero-or-more-than-one in an ambiguous way — so scheduling always
// checks for overlap against the service's own other scheduled/active licenses.
async function loadService(req, res, next) {
  const result = await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Service not found." });
  req.service = result.rows[0];
  next();
}

router.get("/services/:id/licenses", asyncHandler(loadService), asyncHandler(async (req, res) => {
  const licenses = await resolveServiceLicenses(req.service.id);
  res.json({ licenses });
}));

router.post("/services/:id/licenses", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { planId, customDays } = req.body;
  const pricingRow = (await query(`select value from platform_settings where key='plan_prices'`)).rows[0];
  const plan = resolvePlan(planId, customDays, planPricing(pricingRow));
  if (!plan) return res.status(400).json({ error: "Unknown plan type." });

  const result = await query(
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status)
     values ($1,$2,$3,$4,$5,$6,'available') returning *`,
    [req.tenant.id, req.service.id, plan.planId, plan.planLabel, plan.planDays, plan.price]
  );
  const chargeNote = req.tenant.payment_method === "invoice"
    ? `£${plan.price} added to next invoice`
    : `£${plan.price} charged to card on file`;
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License bought for "${req.service.name}" — ${plan.planLabel}, ${chargeNote} (not yet scheduled)`]);
  res.json({ license: result.rows[0], charge: { amount: plan.price, note: chargeNote } });
}));

// Assign (or move) the calendar dates a license covers — one click on a start date, the
// end date is always derived from the plan's fixed length. Only Available/Scheduled
// licenses can be (re)scheduled; Active ones are locked.
router.patch("/services/:id/licenses/:licenseId", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { startDate, unschedule } = req.body;
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });

  if (unschedule) {
    if (license.status !== "scheduled") return res.status(409).json({ error: "Only a scheduled (not yet active) license can be unscheduled." });
    const result = await query(
      `update service_licenses set start_date=null, end_date=null, status='available' where id=$1 returning *`,
      [license.id]
    );
    // A "scheduled" license's whole window is still in the future (it flips to "active" the
    // moment start_date arrives), so it's safe to wipe any hours configured across it —
    // otherwise they'd silently reappear if this service is later rescheduled over the same
    // dates, with no sign anything had been cleared.
    await query(`delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
      [req.service.id, license.start_date, license.end_date]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `License unscheduled for "${req.service.name}" — ${license.plan_label} (${license.start_date} to ${license.end_date}), hours cleared`]);
    return res.json({ license: result.rows[0] });
  }

  if (!startDate) return res.status(400).json({ error: "startDate required." });
  if (license.status !== "available" && license.status !== "scheduled") {
    return res.status(409).json({ error: "An active license's dates can't be changed." });
  }
  const endDate = computeEndDate(startDate, license.plan_days);
  const check = await checkSchedulable(req.service.id, startDate, endDate, license.id);
  if (!check.ok) return res.status(409).json({ error: check.error });

  const wasScheduled = license.status === "scheduled";
  const status = startDate <= getToday() ? "active" : "scheduled";
  const result = await query(
    `update service_licenses set start_date=$1, end_date=$2, status=$3 where id=$4 returning *`,
    [startDate, endDate, status, license.id]
  );
  // "Change dates" on an already-scheduled license moves it, it doesn't start fresh —
  // any hours configured across the OLD window (minus whatever overlaps the new one)
  // are now for dates this license no longer covers, so clear them the same way
  // unscheduling does. Otherwise they sit there invisibly and can resurface if the
  // service is ever rescheduled back over those old dates.
  let hoursCleared = false;
  if (wasScheduled && license.start_date && license.end_date) {
    const cleared = await query(
      `delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3 and not (date >= $4 and date <= $5)`,
      [req.service.id, license.start_date, license.end_date, startDate, endDate]
    );
    hoursCleared = cleared.rowCount > 0;
  }
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License ${wasScheduled ? "moved" : "scheduled"} for "${req.service.name}" — ${license.plan_label}, ${startDate} to ${endDate}${hoursCleared ? " (hours cleared on old dates no longer covered)" : ""}`]);
  res.json({ license: result.rows[0] });
}));

// Move an Available (never-scheduled) license to a different service. Once Scheduled or
// Active it's locked to its service for good.
router.post("/services/:id/licenses/:licenseId/move", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { targetServiceId } = req.body;
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });
  if (license.status !== "available") return res.status(409).json({ error: "Only an unscheduled license can be moved to another service." });
  const target = (await query(`select * from services where id=$1 and tenant_id=$2`, [targetServiceId, req.tenant.id])).rows[0];
  if (!target) return res.status(404).json({ error: "Target service not found." });

  const result = await query(`update service_licenses set service_id=$1 where id=$2 returning *`, [target.id, license.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License moved from "${req.service.name}" to "${target.name}" — ${license.plan_label}`]);
  res.json({ license: result.rows[0] });
}));

// Refund stub — records the cancellation now; real money moves once Stripe is wired up.
router.post("/services/:id/licenses/:licenseId/refund", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });
  if (license.status !== "available") return res.status(409).json({ error: "Only an unscheduled license can be refunded." });
  if (!isWithinRefundWindow(license)) return res.status(409).json({ error: "This license was bought more than 3 months ago and can no longer be refunded." });

  const result = await query(`update service_licenses set status='refunded', refunded_at=now() where id=$1 returning *`, [license.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License refunded for "${req.service.name}" — ${license.plan_label}, £${license.price}`]);
  res.json({ license: result.rows[0] });
}));

// --- Per-day hours & staffing ----------------------------------------------------
async function getServiceWithLicenses(serviceId, tenantId) {
  const svcResult = await query(`select * from services where id=$1 and tenant_id=$2`, [serviceId, tenantId]);
  const service = svcResult.rows[0];
  if (!service) return { service: null, licenses: [] };
  const licenses = await resolveServiceLicenses(serviceId);
  return { service, licenses };
}

router.get("/services/:id/daily-config", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const result = await query(
    `select * from service_daily_config where service_id=$1 and date >= $2 and date <= $3 order by date`,
    [req.params.id, from, to]
  );
  const { licenses } = await getServiceWithLicenses(req.params.id, req.tenant.id);
  const windows = activeAndScheduledWindows(licenses);
  res.json({
    dailyConfig: result.rows,
    windows,
    lockedFrom: windows.length ? windows.map((w) => w.start).sort()[0] : null,
  });
}));

router.put("/services/:id/daily-config", adminOnly, asyncHandler(async (req, res) => {
  const { date, hours, staffCount, bookingStaffCount } = req.body;
  const { service } = await getServiceWithLicenses(req.params.id, req.tenant.id);
  if (!service) return res.status(404).json({ error: "Service not found." });
  if (!(await isServiceLicensedOn(service.id, date))) {
    return res.status(409).json({ error: "That date isn't covered by a license for this service." });
  }
  if (isDateFullyPast(date)) return res.status(409).json({ error: "That date has already passed." });
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
  const sourceResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [req.params.id, fromDate]);
  const source = sourceResult.rows[0] || { hours: [], staff_count: 2, booking_staff_count: 1 };
  let applied = 0;
  for (const date of toDates || []) {
    if (isDateFullyPast(date)) continue;
    if (!(await isServiceLicensedOn(req.params.id, date))) continue;
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

// Clears hours across every one of the service's current scheduled/active windows in one
// call. For today specifically, the client tells us which blocks have already passed (it
// knows the real time; the server only knows the date) so they're preserved rather than wiped.
router.post("/services/:id/daily-config/clear-all", adminOnly, asyncHandler(async (req, res) => {
  const { keepHoursForToday } = req.body;
  const { licenses } = await getServiceWithLicenses(req.params.id, req.tenant.id);
  const windows = activeAndScheduledWindows(licenses);
  if (!windows.length) return res.json({ ok: true, count: 0 });
  const today = getToday();
  let applied = 0;
  for (const window of windows) {
    let d = window.start;
    let guard = 0;
    while (d <= window.end && guard < 400) {
      if (!isDateFullyPast(d)) {
        const hours = d === today ? (keepHoursForToday || []) : [];
        await query(
          `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count)
           values ($1,$2,$3,2,1)
           on conflict (service_id, date) do update set hours = excluded.hours`,
          [req.params.id, d, hours]
        );
        applied++;
      }
      d = addDays(d, 1);
      guard++;
    }
  }
  res.json({ ok: true, count: applied });
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

  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  if (service.archived || !(await isServiceLicensedOn(service.id, date))) {
    return res.json({ open: false, reason: "outside_license_window" });
  }

  // Pause/Resume is a live override that sits on top of the scheduled hours below —
  // it doesn't replace the schedule, it just short-circuits it when active.
  if (service.mode === "queue" && service.queue_paused) return res.json({ open: false, reason: "paused" });

  const dayResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date]);
  const day = dayResult.rows[0];
  if (!day || !day.hours?.length) return res.json({ open: false, reason: "closed" });

  const bookingStaffCount = service.mode === "queue" ? 0 : service.mode === "appointment" ? day.staff_count : day.booking_staff_count;
  const cfg = { slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount, hours: day.hours };

  const blockCountResult = await query(
    `select hour_block, count(*) from tickets
     where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3 group by hour_block`,
    [service.id, date, currentHourBlock(cfg, Number(clockMinutes))]
  );
  const walkInCountInBlock = Number(blockCountResult.rows[0]?.count || 0);
  const walkIn = walkInStatusNow(cfg, walkInCountInBlock, Number(clockMinutes));

  if (service.mode === "queue") {
    return res.json({ open: true, walkIn, bookableSlots: [] });
  }

  const bookedResult = await query(
    `select slot_time, count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' group by slot_time`,
    [service.id, date]
  );
  const bookedCountByTime = {};
  bookedResult.rows.forEach((r) => { bookedCountByTime[r.slot_time] = Number(r.count); });
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, Number(clockMinutes), 3);

  res.json({ open: true, walkIn, bookableSlots });
}));

router.post("/services/:id/tickets", asyncHandler(async (req, res) => {
  const { type, slotTime, hourBlock, date } = req.body;
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  if (service.archived || !(await isServiceLicensedOn(service.id, date))) {
    return res.status(409).json({ error: "We're not taking bookings today — outside this service's licensed period." });
  }

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
