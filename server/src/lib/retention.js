import { query } from "../db/pool.js";

// Automatic deletion of old records, so nothing is kept longer than it is useful. Every period can be changed from the environment
// (0 switches that rule off). Ages are measured from when a record was CREATED on the real clock, never from a visit date, so a
// test or demo date can't make the sweep delete fresh data. WhatsApp numbers are handled separately and much sooner: see lib/whatsappLinks.js.
//
//   RETENTION_HASH_HOURS        48   the scrambled device / connection identifiers kept only to stop one phone taking many places
//   RETENTION_TICKET_DAYS       30   queue tickets (ticket number, service, times, status; no names) and their web-access rows
//   RETENTION_AUDIT_DAYS        90   each organisation's activity log (it records ticket numbers, never names)
//   RETENTION_MESSAGE_LOG_DAYS   7   the simulated message log (sign-in e-mail text and WhatsApp text)
//   sign-in codes (admin, staff, sign-up): deleted one day after they expire
const num = (name, dflt) => { const raw = process.env[name]; const n = Number(raw); return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : dflt; };
export const retentionSettings = () => ({
  hashHours: num("RETENTION_HASH_HOURS", 48),
  ticketDays: num("RETENTION_TICKET_DAYS", 30),
  auditDays: num("RETENTION_AUDIT_DAYS", 90),
  messageLogDays: num("RETENTION_MESSAGE_LOG_DAYS", 7),
});

export async function purgeOldData() {
  const s = retentionSettings();
  const out = {};
  if (s.hashHours > 0) {
    out.hashes = (await query(
      `update ticket_web_access set device_hash = null, ip_hash = null
        where (device_hash is not null or ip_hash is not null) and created_at < now() - make_interval(hours => $1::int)`, [s.hashHours])).rowCount;
  }
  if (s.ticketDays > 0) {
    out.tickets = (await query(`delete from tickets where created_at < now() - make_interval(days => $1::int)`, [s.ticketDays])).rowCount;
  }
  if (s.auditDays > 0) {
    out.audit = (await query(`delete from audit_log where created_at < now() - make_interval(days => $1::int)`, [s.auditDays])).rowCount;
  }
  if (s.messageLogDays > 0) {
    out.messages = (await query(`delete from simulated_messages where created_at < now() - make_interval(days => $1::int)`, [s.messageLogDays])).rowCount;
  }
  out.codes = 0;
  for (const table of ["admin_otp", "staff_otp", "signup_otp"]) {
    // table names come from this fixed list, never from a request
    const sqlByTable = {
      admin_otp: `delete from admin_otp where expires_at < now() - interval '1 day'`,
      staff_otp: `delete from staff_otp where expires_at < now() - interval '1 day'`,
      signup_otp: `delete from signup_otp where expires_at < now() - interval '1 day'`,
    };
    out.codes += (await query(sqlByTable[table])).rowCount;
  }
  return out;
}
