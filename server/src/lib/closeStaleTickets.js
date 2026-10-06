import { query } from "../db/pool.js";
import { getToday } from "./clock.js";

// Any ticket that was called forward but never closed is closed automatically once its day has
// passed, stamped with the end of that day and flagged so reports can tell it from a real close.
// There's no scheduler, so this runs on a timer (see index.js) and again whenever tickets are listed.
export async function closeStaleTickets() {
  const result = await query(
    `update tickets
       set finished_at = ((visit_date + 1)::timestamp at time zone 'Europe/London') - interval '1 second',
           closed_by_system = true
     where status = 'seen' and called_at is not null and finished_at is null and visit_date < $1
     returning tenant_id, ticket_number, visit_date`,
    [getToday()]
  );
  for (const t of result.rows) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [t.tenant_id, `Ticket ${t.ticket_number} (${String(t.visit_date).slice(0, 10)}) wasn't closed by staff — system closed at end of day`]);
  }
  return result.rows.length;
}
