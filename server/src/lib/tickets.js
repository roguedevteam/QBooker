import crypto from "crypto";
import { pool } from "../db/pool.js";
import { getToday, londonNowMinutes } from "./clock.js";
import { currentHourBlock, walkInBudget } from "./scheduling.js";
import { isServiceLicensedOn } from "./serviceLicense.js";
import { dayCfg, offeredSlots } from "./availability.js";
import { badRequest, conflict, HttpError, optEnum, optInt, reqDate, clockMinutesOrUndefined } from "./validate.js";

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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
      `insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status, slot_time, hour_block, visit_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [tenantId, service.id, service.location_id, ticketNumber, type, type === "booked" ? "booked" : "waiting", slotTime, hourBlock, date]
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
  }
}
