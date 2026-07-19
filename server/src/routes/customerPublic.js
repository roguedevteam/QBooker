import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getUpcomingBookableSlots, walkInStatusNow, currentHourBlock } from "../lib/scheduling.js";
import { isWithinPaidWindow } from "../lib/plan.js";

const router = Router();

async function loadTenant(req, res, next) {
  const result = await query(`select * from tenants where id=$1`, [req.params.tenantId]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Business not found." });
  req.tenant = result.rows[0];
  next();
}
router.use("/:tenantId", asyncHandler(loadTenant));

// Only what a customer needs to see — never exposes email, access code, pricing, etc.
router.get("/:tenantId/info", (req, res) => {
  res.json({ businessName: req.tenant.business_name, status: req.tenant.status });
});

router.get("/:tenantId/locations", asyncHandler(async (req, res) => {
  const result = await query(`select id, name from locations where tenant_id=$1 order by created_at`, [req.tenant.id]);
  res.json({ locations: result.rows });
}));

router.get("/:tenantId/services", asyncHandler(async (req, res) => {
  const result = await query(`select id, name, location_id, mode from services where tenant_id=$1 order by created_at`, [req.tenant.id]);
  res.json({ services: result.rows });
}));

router.get("/:tenantId/services/:serviceId/availability", asyncHandler(async (req, res) => {
  const { date, clockMinutes } = req.query;

  if (!isWithinPaidWindow(req.tenant, date)) {
    return res.json({ open: false, reason: "outside_plan_window" });
  }

  const svcResult = await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.serviceId, req.tenant.id]);
  if (svcResult.rows.length === 0) return res.status(404).json({ error: "Service not found." });
  const service = svcResult.rows[0];

  if (service.mode === "queue") {
    if (service.queue_paused) return res.json({ open: false, reason: "paused" });
    const hours = [];
    for (let h = 0; h < 24 * 60; h += 30) hours.push(h);
    const cfg = { slotMinutes: service.slot_minutes, staffCount: service.queue_staff_count, bookingStaffCount: 0, hours };
    const waitingResult = await query(
      `select count(*) from tickets where tenant_id=$1 and service_id=$2 and visit_date=$3 and type='walk_in' and status='waiting'`,
      [req.tenant.id, service.id, date]
    );
    const status = walkInStatusNow(cfg, Number(waitingResult.rows[0]?.count || 0), Number(clockMinutes));
    return res.json({ open: true, walkIn: status, bookableSlots: [] });
  }

  const dayResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date]);
  const day = dayResult.rows[0];
  if (!day || !day.hours?.length) return res.json({ open: false, reason: "closed" });

  const bookingStaffCount = service.mode === "appointment" ? day.staff_count : day.booking_staff_count;
  const cfg = { slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount, hours: day.hours };

  const blockCountResult = await query(
    `select count(*) from tickets
     where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3`,
    [service.id, date, currentHourBlock(cfg, Number(clockMinutes))]
  );
  const walkIn = walkInStatusNow(cfg, Number(blockCountResult.rows[0]?.count || 0), Number(clockMinutes));

  const bookedResult = await query(
    `select slot_time, count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' group by slot_time`,
    [service.id, date]
  );
  const bookedCountByTime = {};
  bookedResult.rows.forEach((r) => { bookedCountByTime[r.slot_time] = Number(r.count); });
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, Number(clockMinutes), 3);

  res.json({ open: true, walkIn, bookableSlots });
}));

router.post("/:tenantId/services/:serviceId/tickets", asyncHandler(async (req, res) => {
  const { type, slotTime, hourBlock, date } = req.body;
  if (!isWithinPaidWindow(req.tenant, date)) {
    return res.status(409).json({ error: "We're not taking bookings today." });
  }
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.serviceId, req.tenant.id])).rows[0];
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

export default router;
