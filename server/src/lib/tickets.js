import crypto from "crypto";
import { pool } from "../db/pool.js";
import { getToday, londonNowMinutes, testNowParam } from "./clock.js";
import { currentHourBlock, walkInBudget } from "./scheduling.js";
import { isServiceLicensedOn } from "./serviceLicense.js";
import { dayCfg, offeredSlots } from "./availability.js";
import { badRequest, conflict, HttpError, optEnum, optInt, reqDate, clockMinutesOrUndefined } from "./validate.js";

const envMs = (name, dflt) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; };
const LOCK_TIMEOUT_MS = envMs("DB_LOCK_TIMEOUT_MS", 8000);
const TX_STATEMENT_TIMEOUT_MS = envMs("DB_TX_STATEMENT_TIMEOUT_MS", 15000);

// In-process FIFO queue per key. Waiting costs no database connection. If a queue gets absurdly long (a flood, or a stalled
// database) new arrivals are refused with a lock_not_available-style error, which the API reports as 503.
const slotTails = new Map(); // key -> { tail: Promise, waiting: number }
const MAX_QUEUED_PER_SERVICE = envMs("TICKET_QUEUE_MAX", 400);
async function acquireSlot(key) {
  let q = slotTails.get(key);
  if (!q) { q = { tail: Promise.resolve(), waiting: 0 }; slotTails.set(key, q); }
  if (q.waiting >= MAX_QUEUED_PER_SERVICE) throw Object.assign(new Error("Too many joins queued for this service"), { code: "55P03" });
  q.waiting++;
  const prev = q.tail;
  let release;
  q.tail = new Promise((r) => { release = r; });
  const finish = () => { q.waiting--; release(); if (q.waiting === 0 && slotTails.get(key) === q) slotTails.delete(key); };
  // Don't wait longer than the database would have (lock_timeout): an abandoned place still hands the turn on once its predecessor is done.
  let timer;
  const timedOut = await Promise.race([prev.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), LOCK_TIMEOUT_MS); })]);
  clearTimeout(timer);
  if (timedOut) { prev.then(finish); throw Object.assign(new Error("Timed out waiting for this service's join queue"), { code: "55P03" }); }
  let released = false;
  return () => { if (!released) { released = true; finish(); } };
}

export const newPublicToken = () => crypto.randomBytes(18).toString("base64url"); // 24 chars, 144 bits

// Validates the shape of a "join / book" request body (no database access).
export function parseTicketRequest(body) {
  const type = optEnum(body.type, "type", ["walk_in", "booked"]);
  if (!type) throw badRequest("type must be walk_in or booked.");
  const date = reqDate(body.date, "date");
  let slotTime = null;
  let hourBlock = null;
  if (type === "booked") {
    slotTime = optInt(body.slotTime, "slotTime", { min: 0, max: 1439 });
    if (slotTime === undefined) throw badRequest("slotTime is required for a booking.");
  } else {
    const hb = optInt(body.hourBlock, "hourBlock", { min: 0, max: 1410 });
    hourBlock = hb === undefined ? null : hb;
  }
  return { type, date, slotTime, hourBlock, clockMinutes: clockMinutesOrUndefined(body.clockMinutes) };
}

// Creates a ticket, enforcing the service's rules. Everything after validation runs in one
// transaction under a per-service-per-day advisory lock, so capacity checks, per-device/IP caps
// and ticket numbering can't race with a simultaneous join.
//   opts.access: when set ({ deviceHash, ipHash, maxPerDevice, maxPerIp }) a ticket_web_access row is
//   created and the device/IP caps are enforced; returns { ticket, publicToken }.
//   opts.audit: audit-log text suffix builder.
export async function createTicket({ tenantId, service, req, access = null, auditSuffix = "" }) {
  const { type, date, slotTime, hourBlock: requestedBlock, clockMinutes } = req;

  if (service.archived || service.location_archived || !(await isServiceLicensedOn(service.id, date))) {
    throw conflict("We're not taking bookings today.", { reason: "outside_license_window" });
  }
  if (date < getToday()) throw conflict("That day has already passed.", { reason: "closed" });

  // Joins to the same service/day are queued here, in memory and WITHOUT holding a database connection, so a rush on one busy
  // service (250 patients pressing Join together) uses one pooled connection at a time instead of pinning the whole pool on
  // the advisory lock below and starving every other clinic. The advisory lock stays: it is what keeps several API instances correct.
  const releaseSlot = await acquireSlot(`${service.id}|${date}`);
  let client;
  try { client = await pool.connect(); } catch (err) { releaseSlot(); throw err; }
  try {
    // Bound how long this transaction may wait for the per-service lock or run at all (SET LOCAL via set_config; works through a
    // transaction-mode pooler too). Without it a stalled lock holder would pin pooled connections
    // indefinitely. Failures surface as 503 (see index.js). The two numbers are validated integers, never user input.
    await client.query("BEGIN");
    await client.query("select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [String(LOCK_TIMEOUT_MS), String(TX_STATEMENT_TIMEOUT_MS)]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ticket|${service.id}|${date}`]);

    const day = (await client.query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date])).rows[0];
    if (!day || !day.hours?.length) throw conflict("We're closed that day.", { reason: "closed" });
    const cfg = dayCfg(service, day);

    let hourBlock = null;
    if (type === "booked") {
      if (service.mode === "queue") throw conflict("This service doesn't take bookings.", { reason: "no_bookings" });
      if (!offeredSlots(cfg).includes(slotTime)) throw conflict("That time isn't available.", { reason: "slot_unavailable" });
      const taken = Number((await client.query(
        `select count(*) from tickets where service_id=$1 and visit_date=$2 and type='booked' and status != 'cancelled' and slot_time=$3`,
        [service.id, date, slotTime]
      )).rows[0].count);
      if (taken >= cfg.bookingStaffCount) throw conflict("That time has just been taken. Please pick another.", { reason: "slot_full" });
    } else {
      if (service.mode === "appointment") throw conflict("This service is by appointment only.", { reason: "no_walk_ins" });
      if (service.mode === "queue" && service.queue_paused) throw conflict("The queue is paused right now. Please try again shortly.", { reason: "paused" });
      if (requestedBlock !== null) {
        if (!cfg.hours.includes(requestedBlock)) throw badRequest("That isn't one of the opening times.");
        hourBlock = requestedBlock;
      } else {
        // The patient app doesn't choose a block: they join the queue for the half-hour they are in now.
        if (date !== getToday()) throw badRequest("hourBlock is required to join the queue on another day.");
        hourBlock = currentHourBlock(cfg, clockMinutes ?? londonNowMinutes());
        if (hourBlock === null) throw conflict("We're closed for today.", { reason: "closed" });
      }
      const budget = walkInBudget(cfg);
      const used = Number((await client.query(
        `select count(*) from tickets where service_id=$1 and visit_date=$2 and type='walk_in' and status != 'cancelled' and hour_block=$3`,
        [service.id, date, hourBlock]
      )).rows[0].count);
      if (budget <= 0 || used >= budget) throw conflict("The queue is full for this time. Please try again later or ask at reception.", { reason: "full" });
    }

    if (access) {
      const activeCount = async (col, val) => Number((await client.query(
        `select count(*) from ticket_web_access a join tickets t on t.id = a.ticket_id
         where t.service_id=$1 and t.visit_date=$2 and t.status in ('waiting','booked') and a.${col}=$3`,
        [service.id, date, val]
      )).rows[0].count);
      if (access.deviceHash && (await activeCount("device_hash", access.deviceHash)) >= access.maxPerDevice) {
        throw new HttpError(429, "You already have a place in this queue on this phone. Leave it first if you want to join again.", { reason: "too_many_device" });
      }
      if (access.ipHash && (await activeCount("ip_hash", access.ipHash)) >= access.maxPerIp) {
        throw new HttpError(429, "Too many people are joining from this connection right now. Please ask at reception.", { reason: "too_many_ip" });
      }
    }

    // Next number = highest issued so far today + 1 (not a count, so deleting a ticket never causes a repeat).
    const maxRow = (await client.query(
      `select coalesce(max((substring(ticket_number from '-(\\d+)$'))::int), 0) as n from tickets where service_id=$1 and visit_date=$2`,
      [service.id, date]
    )).rows[0];
    const initials = (service.name.match(/\b\w/g) || ["S", "V"]).slice(0, 2).join("").toUpperCase();
    const ticketNumber = `${initials}-${String(Number(maxRow.n) + 1).padStart(3, "0")}`;

    const ticket = (await client.query(
      `insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status, slot_time, hour_block, visit_date, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now())) returning *`,
      [tenantId, service.id, service.location_id, ticketNumber, type, type === "booked" ? "booked" : "waiting", slotTime, hourBlock, date, testNowParam()]
    )).rows[0];
    let publicToken = null;
    if (access) {
      publicToken = newPublicToken();
      await client.query(
        `insert into ticket_web_access (token, ticket_id, tenant_id, channel, device_hash, ip_hash) values ($1,$2,$3,'web',$4,$5)`,
        [publicToken, ticket.id, tenantId, access.deviceHash, access.ipHash]
      );
    }
    await client.query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [tenantId, `Ticket ${ticketNumber} ${type === "booked" ? `booked ${service.name}` : `joined the ${service.name} queue (walk-in${auditSuffix})`}`]);
    await client.query("COMMIT");
    return { ticket, publicToken };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    releaseSlot();
  }
}
