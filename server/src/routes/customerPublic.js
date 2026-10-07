import { Router } from "express";
import crypto from "crypto";
import { query } from "../db/pool.js";
import { rateLimit } from "../lib/rateLimit.js";
import { getToday } from "../lib/clock.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getUpcomingBookableSlots, walkInStatusNow, currentHourBlock, estimateWalkInWaitMinutes } from "../lib/scheduling.js";
import { isServiceLicensedOn } from "../lib/serviceLicense.js";

const router = Router();

// --- Web channel helpers ---------------------------------------------------------------
// Abuse limits for the web channel (per service, per day, counting tickets still waiting/booked).
// The IP limit is deliberately looser than the device limit: a clinic's patients often share one
// public IP (waiting-room wifi / mobile carrier NAT), so a tight per-IP cap would lock real
// patients out.
const MAX_ACTIVE_PER_DEVICE = 2;
const MAX_ACTIVE_PER_IP = 6;

function hashValue(v) {
  const salt = process.env.JWT_SECRET || "qbooker";
  return crypto.createHash("sha256").update(`${salt}|${v}`).digest("hex");
}
function newPublicToken() { return crypto.randomBytes(18).toString("base64url"); } // 24 chars, 144 bits
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CHANNEL_MODES = ["whatsapp", "web", "both"];

async function loadTenant(req, res, next) {
  const result = await query(`select * from tenants where id=$1`, [req.params.tenantId]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Business not found." });
  if (result.rows[0].status === "disabled") return res.status(404).json({ error: "Business not found." });
  req.tenant = result.rows[0];
  next();
}
router.use("/:tenantId", asyncHandler(loadTenant));

// Only meaningful for a waiting walk-in — a booked ticket already has its slot time, and a
// called/cancelled ticket has nothing left to wait for. Mirrors call-next's own queue
// ordering (FIFO by created_at, no hour-block split) so the position shown actually matches
// who gets called next.
async function getQueueInfo(ticket) {
  if (ticket.type !== "walk_in" || ticket.status !== "waiting") return null;
  const service = (await query(`select * from services where id=$1`, [ticket.service_id])).rows[0];
  if (!service) return null;
  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [ticket.service_id, ticket.visit_date])).rows[0];
  if (!day) return null;
  const walkInStaffCount = service.mode === "queue" ? day.staff_count : service.mode === "appointment" ? 0 : day.walkin_staff_count;
  const cfg = { slotMinutes: service.slot_minutes, walkInStaffCount };
  const aheadResult = await query(
    `select count(*) from tickets where service_id=$1 and visit_date=$2 and type='walk_in' and status='waiting' and created_at < $3`,
    [ticket.service_id, ticket.visit_date, ticket.created_at]
  );
  const aheadCount = Number(aheadResult.rows[0]?.count || 0);
  return { position: aheadCount + 1, estimatedMinutes: estimateWalkInWaitMinutes(cfg, aheadCount) };
}

// Only what a customer needs to see — never exposes email, access code, pricing, etc.
router.get("/:tenantId/info", (req, res) => {
  res.json({ businessName: req.tenant.business_name, status: req.tenant.status });
});

// The location code is intentionally NOT returned here: when a location is "onsite only" it is
// the on-site secret (printed on the QR poster / known at reception), so it must not be
// readable from a public API.
router.get("/:tenantId/locations", asyncHandler(async (req, res) => {
  const result = await query(
    // Join settings are account-wide (on tenants); the response keeps its per-location shape so the
    // customer app is unchanged.
    `select l.id, l.name, l.website_url, te.channel_mode, te.whatsapp_updates_offer, te.onsite_only from locations l
     join tenants te on te.id = l.tenant_id
     where l.tenant_id=$1 and l.archived=false order by l.created_at`,
    [req.tenant.id]
  );
  res.json({ locations: result.rows });
}));

// A service is only ever shown to customers once it has a scheduled or active license —
// never while archived, and never while every license on it is still unscheduled/expired.
router.get("/:tenantId/services", asyncHandler(async (req, res) => {
  const result = await query(
    `select distinct s.id, s.name, s.location_id, s.mode from services s
     join service_licenses sl on sl.service_id = s.id and sl.status in ('scheduled','active')
     where s.tenant_id=$1 and s.archived=false order by s.name`,
    [req.tenant.id]
  );
  res.json({ services: result.rows });
}));

router.get("/:tenantId/services/:serviceId/availability", asyncHandler(async (req, res) => {
  const { date, clockMinutes } = req.query;

  const svcResult = await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.serviceId, req.tenant.id]);
  if (svcResult.rows.length === 0) return res.status(404).json({ error: "Service not found." });
  const service = svcResult.rows[0];

  if (service.archived || !(await isServiceLicensedOn(service.id, date))) {
    return res.json({ open: false, reason: "outside_license_window" });
  }

  if (service.mode === "queue" && service.queue_paused) return res.json({ open: false, reason: "paused" });

  const dayResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date]);
  const day = dayResult.rows[0];
  if (!day || !day.hours?.length) return res.json({ open: false, reason: "closed" });

  const bookingStaffCount = service.mode === "queue" ? 0 : service.mode === "appointment" ? day.staff_count : day.booking_staff_count;
  const walkInStaffCount = service.mode === "queue" ? day.staff_count : service.mode === "appointment" ? 0 : day.walkin_staff_count;
  const cfg = { slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount, walkInStaffCount, hours: day.hours };

  const blockCountResult = await query(
    `select count(*) from tickets
     where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3`,
    [service.id, date, currentHourBlock(cfg, Number(clockMinutes))]
  );
  const walkIn = walkInStatusNow(cfg, Number(blockCountResult.rows[0]?.count || 0), Number(clockMinutes));

  if (service.mode === "queue") {
    return res.json({ open: true, walkIn, bookableSlots: [] });
  }

  const bookedResult = await query(
    `select slot_time, count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' group by slot_time`,
    [service.id, date]
  );
  const bookedCountByTime = {};
  bookedResult.rows.forEach((r) => { bookedCountByTime[r.slot_time] = Number(r.count); });
  const bookableSlots = getUpcomingBookableSlots(cfg, bookedCountByTime, Number(clockMinutes), 200);

  res.json({ open: true, walkIn, bookableSlots });
}));

// Polled by the customer app after joining/booking, since it's a fully separate app from
// the staff kiosk with no other way to learn it's been called forward.
router.get("/:tenantId/tickets/:ticketId/status", asyncHandler(async (req, res) => {
  const ticket = (await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.ticketId, req.tenant.id])).rows[0];
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  let message = null;
  if (ticket.status === "serving" || ticket.status === "completed") {
    const m = (await query(
      `select body from simulated_messages where tenant_id=$1 and to_reference=$2 and channel='whatsapp' order by created_at desc limit 1`,
      [req.tenant.id, ticket.ticket_number]
    )).rows[0];
    message = m?.body || null;
  }
  const queue = await getQueueInfo(ticket);
  res.json({ status: ticket.status, ticketNumber: ticket.ticket_number, message, queue, arrived: !!ticket.arrived_at });
}));

// Self-service cancel — lets a customer back out of a queue or booking themselves instead of
// having to contact the business. Only touches their own ticket, and only while it's still
// pending (no undoing a cancel on something already called/cancelled/no-show).
router.post("/:tenantId/tickets/:ticketId/cancel", asyncHandler(async (req, res) => {
  const ticket = (await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.ticketId, req.tenant.id])).rows[0];
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  if (!["waiting", "booked"].includes(ticket.status)) {
    return res.status(409).json({ error: "This ticket can no longer be cancelled." });
  }
  const result = await query(`update tickets set status='cancelled' where id=$1 returning *`, [ticket.id]);
  const service = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} cancelled by customer for ${service?.name || "service"}`]);
  res.json({ ticket: result.rows[0] });
}));

// Check-in for a booked appointment — tells staff the customer is here. It doesn't change when
// they're called (that's still the slot time, or staff can call them early from the waiting list).
router.post("/:tenantId/tickets/:ticketId/check-in", asyncHandler(async (req, res) => {
  const ticket = (await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.ticketId, req.tenant.id])).rows[0];
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  if (ticket.type !== "booked" || ticket.status !== "booked") {
    return res.status(409).json({ error: "This booking can't be checked in." });
  }
  const result = await query(`update tickets set arrived_at=coalesce(arrived_at, now()) where id=$1 returning *`, [ticket.id]);
  const service = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} checked in for ${service?.name || "service"}`]);
  res.json({ ticket: result.rows[0] });
}));

router.post("/:tenantId/services/:serviceId/tickets", rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: "Too many join attempts from this connection. Please wait a few minutes or ask at reception." }), asyncHandler(async (req, res) => {
  const { type, slotTime, hourBlock, date, onsiteCode, deviceId } = req.body;
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.serviceId, req.tenant.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  if (service.archived || !(await isServiceLicensedOn(service.id, date))) {
    return res.status(409).json({ error: "We're not taking bookings today." });
  }

  // Account-wide web-channel rules (req.tenant); only the on-site code is per location.
  if (req.tenant.channel_mode === "whatsapp") {
    return res.status(403).json({ error: "This clinic takes joins through WhatsApp only. Please use WhatsApp, or ask at reception.", reason: "channel_whatsapp_only" });
  }
  // On-site check: only for joining the live queue (a booking made in advance from home is fine).
  // The code must match this location's code (the one in the QR link / on the poster). It is a
  // shared secret, not proof of presence — there is no geofencing.
  if (req.tenant.onsite_only && type === "walk_in") {
    const supplied = String(onsiteCode || "").trim().toUpperCase();
    const row = (await query(`select code from location_codes where location_id=$1`, [service.location_id])).rows[0];
    if (!supplied) {
      return res.status(403).json({ error: "Please scan the QR code at reception, or enter the location code shown there.", reason: "onsite_code_required" });
    }
    if (!row || row.code.toUpperCase() !== supplied) {
      return res.status(403).json({ error: "That location code isn't right. Check the code shown at reception.", reason: "onsite_code_invalid" });
    }
  }

  // Simultaneous-ticket limits per device and per IP for this service today.
  const deviceHash = DEVICE_RE.test(String(deviceId || "")) ? hashValue(`device|${deviceId}`) : null;
  const ipHash = req.ip ? hashValue(`ip|${req.ip}`) : null;
  const activeCount = async (col, val) => Number((await query(
    `select count(*) from ticket_web_access a join tickets t on t.id = a.ticket_id
     where t.service_id=$1 and t.visit_date=$2 and t.status in ('waiting','booked') and a.${col}=$3`,
    [service.id, date, val]
  )).rows[0].count);
  if (deviceHash && (await activeCount("device_hash", deviceHash)) >= MAX_ACTIVE_PER_DEVICE) {
    return res.status(429).json({ error: "You already have a place in this queue on this phone. Leave it first if you want to join again.", reason: "too_many_device" });
  }
  if (ipHash && (await activeCount("ip_hash", ipHash)) >= MAX_ACTIVE_PER_IP) {
    return res.status(429).json({ error: "Too many people are joining from this connection right now. Please ask at reception.", reason: "too_many_ip" });
  }

  const countResult = await query(`select count(*) from tickets where service_id=$1 and visit_date=$2`, [service.id, date]);
  const count = Number(countResult.rows[0].count) + 1;
  const initials = (service.name.match(/\b\w/g) || ["S", "V"]).slice(0, 2).join("").toUpperCase();
  const ticketNumber = `${initials}-${String(count).padStart(3, "0")}`;

  // One statement so a ticket never exists without its public token.
  const publicToken = newPublicToken();
  const result = await query(
    `with t as (
       insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status, slot_time, hour_block, visit_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *
     ), a as (
       insert into ticket_web_access (token, ticket_id, tenant_id, channel, device_hash, ip_hash)
       select $10, t.id, t.tenant_id, 'web', $11, $12 from t
     )
     select * from t`,
    [req.tenant.id, service.id, service.location_id, ticketNumber, type, type === "booked" ? "booked" : "waiting", slotTime ?? null, hourBlock ?? null, date, publicToken, deviceHash, ipHash]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticketNumber} ${type === "booked" ? `booked ${service.name}` : `joined the ${service.name} queue (walk-in, web)`}`]);
  const queue = await getQueueInfo(result.rows[0]);
  res.json({ ticket: result.rows[0], queue, publicToken });
}));

// --- Login-free ticket access by unguessable token --------------------------------------
// Mounted at /api/public/ticket. The token is the only credential: it identifies exactly one
// ticket. Responses carry ticket number, queue position and room only — no names, phone numbers
// or clinical data are held on a ticket in the first place.
export const publicTicketRouter = Router();
publicTicketRouter.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
publicTicketRouter.use(rateLimit({ windowMs: 60 * 1000, max: 90 }));

async function loadByToken(req, res, next) {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: "Ticket not found.", state: "unknown" });
  const row = (await query(
    `select t.*, a.whatsapp_updates_requested, s.name as service_name, l.name as location_name, te.whatsapp_updates_offer, te.business_name
     from ticket_web_access a
     join tickets t on t.id = a.ticket_id
     join tenants te on te.id = t.tenant_id
     left join services s on s.id = t.service_id
     left join locations l on l.id = t.location_id
     where a.token=$1`,
    [req.params.token]
  )).rows[0];
  if (!row) return res.status(404).json({ error: "Ticket not found.", state: "unknown" });
  req.ticketRow = row;
  next();
}

// waiting | called | closed | cancelled | expired.
// The tickets table has a single "serving" status for "called, not finished" (no separate
// called-vs-serving stage), so serving is reported as "called"; completed and no_show are "closed".
function publicState(t) {
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "serving") return "called";
  if (t.status === "completed" || t.status === "seen" || t.status === "no_show") return "closed";
  if (String(t.visit_date).slice(0, 10) < getToday()) return "expired";
  return "waiting"; // waiting | booked
}

publicTicketRouter.get("/:token", asyncHandler(loadByToken), asyncHandler(async (req, res) => {
  const t = req.ticketRow;
  const state = publicState(t);
  const queue = state === "waiting" ? await getQueueInfo(t) : null;
  res.json({
    state,
    ticketNumber: t.ticket_number,
    type: t.type,
    slotTime: t.type === "booked" ? t.slot_time : null,
    peopleAhead: queue ? queue.position - 1 : null,
    estimatedMinutes: queue ? queue.estimatedMinutes : null,
    serviceName: t.service_name,
    locationName: t.location_name,
    businessName: t.business_name,
    calledRoom: state === "called" ? (t.called_room || null) : null,
    whatsappUpdatesOffer: !!t.whatsapp_updates_offer,
    whatsappUpdatesRequested: !!t.whatsapp_updates_requested,
    updatedAt: new Date().toISOString(),
  });
}));

publicTicketRouter.post("/:token/leave", asyncHandler(loadByToken), asyncHandler(async (req, res) => {
  const t = req.ticketRow;
  if (t.status === "cancelled") return res.json({ state: "cancelled" }); // idempotent
  if (!["waiting", "booked"].includes(t.status) || publicState(t) === "expired") {
    return res.status(409).json({ error: "This ticket can no longer be cancelled.", state: publicState(t) });
  }
  await query(`update tickets set status='cancelled' where id=$1 and status in ('waiting','booked')`, [t.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [t.tenant_id, `Ticket ${t.ticket_number} cancelled by customer (web) for ${t.service_name || "service"}`]);
  res.json({ state: "cancelled" });
}));

// STUB: records that the patient would like WhatsApp updates. Sends nothing and collects no
// phone number — the WhatsApp business number isn't connected yet.
publicTicketRouter.post("/:token/whatsapp-intent", asyncHandler(loadByToken), asyncHandler(async (req, res) => {
  await query(
    `update ticket_web_access set whatsapp_updates_requested=true, whatsapp_updates_requested_at=coalesce(whatsapp_updates_requested_at, now()) where token=$1`,
    [req.params.token]
  );
  res.json({ ok: true, delivered: false });
}));

export default router;
