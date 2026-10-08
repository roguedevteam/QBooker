import { query } from "../db/pool.js";
import { getSimulatedToday, testNowParam } from "./clock.js";

// Any ticket that was called forward but never closed is closed automatically once its day has
// passed, stamped with the end of that day and flagged so reports can tell it from a real close.
// "Its day has passed" is judged in the time zone of the ticket's own LOCATION (a clinic in New York closes its
// day hours after one in London), and the end of that day is that zone's local midnight less a second. The System
// Admin simulated date, when set, replaces the date for every zone (as everywhere else).
// There's no scheduler, so this runs on a timer (see index.js) and again whenever tickets are listed.
export async function closeStaleTickets() {
  const result = await query(
    `update tickets t
        set status = 'completed', finished_at = ((t.visit_date + 1)::timestamp at time zone l.timezone) - interval '1 second',
            closed_by_system = true
       from locations l
      where l.id = t.location_id
        and t.status = 'serving' and t.called_at is not null and t.finished_at is null
        and t.visit_date < coalesce($2::date, (coalesce($1::timestamptz, now()) at time zone l.timezone)::date)
      returning t.tenant_id, t.ticket_number, t.visit_date`,
    [testNowParam(), getSimulatedToday()]
  );
  for (const t of result.rows) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [t.tenant_id, `Ticket ${t.ticket_number} (${String(t.visit_date).slice(0, 10)}) wasn't closed by staff — system closed at end of day`]);
  }
  return result.rows.length;
}
