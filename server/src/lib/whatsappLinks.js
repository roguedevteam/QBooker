import crypto from "crypto";
import { query } from "../db/pool.js";
import { getSimulatedToday, testNowParam } from "./clock.js";
import { sendWhatsApp, whatsappStatus } from "./whatsapp.js";
import { t, resolveLang } from "./i18n.js";

// A WhatsApp number is tied to a single ticket. We never ask for it: the patient sends us a code from WhatsApp and WhatsApp tells us
// which number it came from. The number is the only patient data kept for WhatsApp, and it is deleted as soon as it is not needed
// (see purgeWhatsAppNumbers). Message text is never stored against it.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const LINK_CODE_RE = /QT-[A-Z2-9]{6}/;
export const genLinkCode = () => "QT-" + Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

// The link row for a ticket, created on first use. (It holds only a random code until a patient actually connects.)
export async function ensureLink(ticketId, tenantId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await query(
      `insert into ticket_whatsapp_links (ticket_id, tenant_id, link_code) values ($1,$2,$3) on conflict (ticket_id) do nothing`,
      [ticketId, tenantId, genLinkCode()]
    ).catch((err) => { if (err.code !== "23505") throw err; }); // a code collision (23505 on link_code) just retries with a new code
    const row = (await query(`select * from ticket_whatsapp_links where ticket_id=$1`, [ticketId])).rows[0];
    if (row) return row;
  }
  return null;
}

// Only a ticket still in play can be linked: waiting, booked or being served, and not from an earlier day.
// Attaches `phone` to the ticket that owns `code`. Returns { result, ticketNumber, tenantId }.
//   linked        the number is now attached (or was already)
//   expired       the ticket has ended or is from an earlier day
//   taken         another number is already connected to this ticket: ignored, so a leaked code can't redirect someone's messages
//   unknown       no such code
export async function linkPhoneToTicket(code, phone) {
  const found = (await query(
    `select k.ticket_id, k.tenant_id, k.phone_number, t.ticket_number, (t.status in ('waiting','booked','serving')
                 and t.visit_date >= coalesce($2::date, (coalesce($3::timestamptz, now()) at time zone l.timezone)::date)) as linkable
       from ticket_whatsapp_links k
       join tickets t on t.id = k.ticket_id
       join locations l on l.id = t.location_id
      where k.link_code = $1`,
    [code, getSimulatedToday(), testNowParam()]
  )).rows[0];
  if (!found) return { result: "unknown" };
  if (!found.linkable) return { result: "expired", tenantId: found.tenant_id };
  if (found.phone_number && found.phone_number !== phone) return { result: "taken", tenantId: found.tenant_id };
  if (!found.phone_number) {
    await query(`update ticket_whatsapp_links set phone_number=$1, connected_at=now() where ticket_id=$2 and phone_number is null`, [phone, found.ticket_id]);
  }
  return { result: "linked", ticketNumber: found.ticket_number, tenantId: found.tenant_id };
}

// STOP: forget this number everywhere, straight away.
export async function forgetPhone(phone) {
  const r = await query(`update ticket_whatsapp_links set phone_number=null where phone_number=$1 returning tenant_id`, [phone]);
  await query(`delete from whatsapp_sessions where phone_number=$1`, [phone]);
  return { cleared: r.rowCount, tenantId: r.rows[0]?.tenant_id || null };
}

// Sends `text` to the number linked to this ticket, if there is one. Never throws and never blocks the caller for long.
export async function notifyTicket(ticketId, tenantId, text) {
  try {
    if (!whatsappStatus().ready) return false;
    const row = (await query(`select phone_number from ticket_whatsapp_links where ticket_id=$1`, [ticketId])).rows[0];
    if (!row?.phone_number) return false;
    await sendWhatsApp({ to: row.phone_number, text, tenantId });
    return true;
  } catch (err) {
    console.warn(`[whatsapp] ticket message not sent: ${err.message}`);
    return false;
  }
}

// After somebody is called, whoever is now first in the walk-in queue for that service and day gets one "you're next" message.
export async function notifyNextInLine({ serviceId, tenantId, visitDate }) {
  try {
    const next = (await query(
      `select t.id, t.ticket_number, k.phone_number, k.next_notified_at
         from tickets t left join ticket_whatsapp_links k on k.ticket_id = t.id
        where t.service_id=$1 and t.tenant_id=$2 and t.visit_date=$3 and t.type='walk_in' and t.status='waiting'
        order by t.created_at asc limit 1`,
      [serviceId, tenantId, visitDate]
    )).rows[0];
    if (!next || !next.phone_number || next.next_notified_at) return false;
    const claimed = await query(`update ticket_whatsapp_links set next_notified_at=now() where ticket_id=$1 and next_notified_at is null returning ticket_id`, [next.id]);
    if (claimed.rowCount === 0) return false;
    return await notifyTicket(next.id, tenantId, t(resolveLang(), "whatsapp.next", { ticket: next.ticket_number }));
  } catch (err) {
    console.warn(`[whatsapp] next-in-line message not sent: ${err.message}`);
    return false;
  }
}

// Deletes numbers that are no longer needed:
//   - the ticket is completed, seen or cancelled (a no-show keeps its number until the end of the day, so staff can put it back in the queue)
//   - the ticket's day has ended in its location's time zone
//   - the number was connected more than 24 hours ago (safety net)
// Also clears location-code sessions older than 24 hours. Returns how many numbers were cleared.
export async function purgeWhatsAppNumbers() {
  const r = await query(
    `update ticket_whatsapp_links k set phone_number = null
       from tickets t join locations l on l.id = t.location_id
      where k.ticket_id = t.id and k.phone_number is not null
        and ( t.status in ('completed','seen','cancelled')
           or t.visit_date < coalesce($1::date, (coalesce($2::timestamptz, now()) at time zone l.timezone)::date)
           or k.connected_at < now() - interval '24 hours' )`,
    [getSimulatedToday(), testNowParam()]
  );
  await query(`delete from whatsapp_sessions where updated_at < now() - interval '24 hours'`);
  return r.rowCount;
}
