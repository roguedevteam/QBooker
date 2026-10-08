// Seeds realistic history into the throwaway DB: HIST_TENANTS tenants (name lt-hist-*) x 2 services, ~TICKETS tickets
// spread over the last 90 days (with web-access tokens for half), ~2 audit rows per ticket and simulated WhatsApp messages.
// Idempotent-ish: skips when lt-hist tenants already exist unless FORCE=1. Cleanup: node cleanup.mjs
import { sql, today, ALLDAY, report } from "./lib.mjs";

const T = Number(process.env.HIST_TENANTS || 40);
const TICKETS = Number(process.env.TICKETS || 50000);
const have = (await sql(`select count(*)::int n from tenants where business_name like 'lt-hist-%'`))[0].n;
if (have >= T && process.env.FORCE !== "1") { console.log(`already seeded (${have} lt-hist tenants)`); process.exit(0); }

const t0 = Date.now();
await sql(`insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name)
           select 'lt-hist-'||g, 'lt-hist-'||g||'-'||substr(md5(random()::text),1,6)||'@example.com', 1, 'ACCESS', 'card', 'active','H','T' from generate_series(1,$1) g`, [T]);
await sql(`insert into locations (tenant_id,name,address,staff_access_code) select id,'Main','', 'H-'||substr(md5(id::text),1,10) from tenants where business_name like 'lt-hist-%' and not exists (select 1 from locations l where l.tenant_id=tenants.id)`);
await sql(`insert into services (tenant_id,location_id,name,mode,slot_minutes)
           select l.tenant_id, l.id, n, 'hybrid', 15 from locations l join tenants t on t.id=l.tenant_id cross join (values ('Dental Care'),('Hygiene')) v(n) where t.business_name like 'lt-hist-%' and not exists (select 1 from services s where s.location_id=l.id)`);
// Tickets: pick a random service and date per row. Heavy-tailed: tenant #1 gets ~25% of everything.
await sql(`
  with svc as (select s.id sid, s.tenant_id tid, s.location_id lid, row_number() over (order by s.id) rn, count(*) over () cnt
              from services s join tenants t on t.id=s.tenant_id where t.business_name like 'lt-hist-%'),
  pick as (select g, case when random()<0.25 then 1 + (random()*1)::int else 1 + floor(random()*(select max(cnt) from svc))::int end rn from generate_series(1,$1) g)
  insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,slot_time,hour_block,visit_date,created_at,called_at,finished_at,called_room)
  select s.tid,s.sid,s.lid,'DC-'||lpad((row_number() over (partition by s.sid, d.dt order by p.g))::text,3,'0'),
         case when random()<0.3 then 'booked' else 'walk_in' end,
         (array['completed','completed','completed','completed','no_show','cancelled'])[1+floor(random()*6)::int],
         null, (floor(random()*20)*30+480)::int, d.dt, d.dt::timestamptz + interval '9 hours' + (random()*8||' hours')::interval,
         d.dt::timestamptz + interval '10 hours', d.dt::timestamptz + interval '10 hours 20 minutes', 'Room 1'
  from pick p join svc s on s.rn = p.rn cross join lateral (select (current_date - (1+floor(random()*90))::int) dt) d`, [TICKETS]);
await sql(`insert into ticket_web_access (token,ticket_id,tenant_id,device_hash,ip_hash)
           select substr(md5(id::text)||md5(id::text||'x'),1,24), id, tenant_id, md5(random()::text), md5(random()::text) from tickets t
           where tenant_id in (select id from tenants where business_name like 'lt-hist-%') and random()<0.5
             and not exists (select 1 from ticket_web_access a where a.ticket_id=t.id)`);
await sql(`insert into audit_log (tenant_id,message,created_at)
           select tenant_id,'Ticket '||ticket_number||' event '||g, created_at + (g||' minutes')::interval from tickets, generate_series(1,2) g
           where tenant_id in (select id from tenants where business_name like 'lt-hist-%')`);
await sql(`insert into simulated_messages (tenant_id,channel,to_reference,body,created_at)
           select tenant_id,'whatsapp',ticket_number,'It''s your turn!',called_at from tickets
           where tenant_id in (select id from tenants where business_name like 'lt-hist-%') and status='completed'`);
await sql(`analyze`);
const c = (await sql(`select (select count(*) from tickets)::int tickets, (select count(*) from audit_log)::int audit, (select count(*) from simulated_messages)::int sim, (select count(*) from ticket_web_access)::int access, (select count(*) from tenants)::int tenants`))[0];
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`, c);
process.exit(0);
