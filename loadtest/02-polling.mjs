// Scenario 2 - polling load. PATIENTS patient pages poll GET /api/public/ticket/:token every 10 s (customer/src/Returning.jsx POLL_MS),
// KIOSKS staff kiosks poll GET /api/tenant/tickets every 8 s (staff/src/Shift.jsx) and /today every 30 s, and the admin dashboard
// polls /tickets + /dashboard/stats every 10 s (customer-admin/src/App.jsx). Run with IP_MODE=shared to put every patient behind
// ONE public IP (clinic wifi / carrier NAT) instead of a distinct IP each. DURATION_S controls the length.
import { http, seedTenant, sql, sleep, summarize, report, table, randIp, startPgSampler, readMetrics, metricsSummary, logErrors, logSize, rid, ALLDAY } from "./lib.mjs";

const PATIENTS = Number(process.env.PATIENTS || 300);
const KIOSKS = Number(process.env.KIOSKS || 5);
const DURATION_S = Number(process.env.DURATION_S || 90);
const SHARED = process.env.IP_MODE === "shared";
const TAG = process.env.TAG || "";
const logStart = logSize();

const t = await seedTenant({ name: "poll", staffN: KIOSKS, services: [{ name: "Poll Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 60, bookingStaffCount: 5, walkInStaffCount: 50 }] });
const svc = t.services[0];
// Waiting walk-ins created straight in SQL (the join path is scenario 1).
await sql(`with n as (select g from generate_series(1,$3::int) g),
  ins as (insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,hour_block,visit_date,created_at)
          select $1,$2,$4,'PC-'||lpad(g::text,3,'0'),'walk_in','waiting',480,$5::date, now() - (($3::int - g) || ' seconds')::interval from n returning id, ticket_number)
  insert into ticket_web_access (token, ticket_id, tenant_id, device_hash, ip_hash)
  select substr(md5(id::text)||md5(ticket_number),1,24), id, $1, md5(random()::text), md5(random()::text) from ins`, [t.tid, svc.id, PATIENTS, t.lid, t.today]);
const tokens = (await sql(`select token from ticket_web_access where tenant_id=$1`, [t.tid])).map((r) => r.token);
// Also a few hundred rows of today's activity in the audit log so the tenant looks lived-in
await sql(`insert into audit_log (tenant_id,message) select $1,'seed '||g from generate_series(1,300) g`, [t.tid]);

const sharedIp = randIp();
const lat = { patient: [], kiosk: [], kioskToday: [], adminTickets: [], adminStats: [] };
const codes = {};
const bump = (k, s) => { const key = `${k}:${s}`; codes[key] = (codes[key] || 0) + 1; };
let stop = false;
const loops = [];
const loop = (periodMs, fn) => loops.push((async () => { await sleep(Math.random() * periodMs); while (!stop) { const t0 = Date.now(); await fn(); await sleep(Math.max(0, periodMs - (Date.now() - t0))); } })());

tokens.forEach((tok) => loop(10000, async () => { const r = await http("GET", `/api/public/ticket/${tok}`, { ip: SHARED ? sharedIp : randIp() }); lat.patient.push(r.ms); bump("patient", r.status); }));
t.staff.forEach((s) => {
  loop(8000, async () => { const r = await http("GET", `/api/tenant/tickets`, { token: s.token, ip: randIp() }); lat.kiosk.push(r.ms); bump("kiosk", r.status); });
  loop(30000, async () => { const r = await http("GET", `/api/tenant/today?serviceId=${svc.id}`, { token: s.token, ip: randIp() }); lat.kioskToday.push(r.ms); bump("kioskToday", r.status); });
});
loop(10000, async () => { const [a, b] = await Promise.all([http("GET", `/api/tenant/tickets`, { token: t.adminToken }), http("GET", `/api/tenant/dashboard/stats`, { token: t.adminToken })]); lat.adminTickets.push(a.ms); lat.adminStats.push(b.ms); bump("admin", a.status); bump("admin", b.status); });

const sampler = startPgSampler(500);
const m0 = Date.now();
await sleep(DURATION_S * 1000);
stop = true; await Promise.all(loops); await sampler.stop();
const ms = metricsSummary(readMetrics(m0 + 5000)); // skip warm-up
const reqCount = Object.values(lat).reduce((a, l) => a + l.length, 0);
const rps = reqCount / DURATION_S;
const rows = [
  ["patients (" + PATIENTS + " pages, 10 s, " + (SHARED ? "ONE shared IP" : "distinct IPs") + ")", summarize(lat.patient)],
  ["staff kiosks GET /tenant/tickets (" + KIOSKS + " x 8 s)", summarize(lat.kiosk)],
  ["staff kiosks GET /tenant/today (30 s)", summarize(lat.kioskToday)],
  ["admin GET /tenant/tickets (10 s)", summarize(lat.adminTickets)],
  ["admin GET /dashboard/stats (10 s)", summarize(lat.adminStats)],
].map(([n, s]) => [n, s.n, s.p50, s.p95, s.p99, s.max]);
const lines = [
  `**${DURATION_S}s run ${TAG}**, DB holds ${(await sql(`select count(*)::int n from tickets`))[0].n} tickets / ${(await sql(`select count(*)::int n from audit_log`))[0].n} audit rows.`,
  ...table(["traffic", "requests", "p50 ms", "p95 ms", "p99 ms", "max ms"], rows),
  "",
  ...table(["metric", "value"], [
    ["status codes", JSON.stringify(codes)],
    ["offered load (HTTP req/s)", rps.toFixed(1)],
    ["DB queries/s avg / peak", `${ms.avgQps} / ${ms.peakQps}  (=> ~${(ms.avgQps / rps).toFixed(1)} queries per request)`],
    ["DB connections max / max active", `${sampler.summary().maxConns} / ${sampler.summary().maxActive}`],
    ["event-loop lag p99 max / max ms", `${ms.lagP99Max} / ${ms.lagMax}`],
    ["failed queries / pool errors", `${ms.failedQueries} / ${ms.poolErrors}`],
    ["log errors", logErrors(logStart).length],
  ]),
];
report(`Scenario 2 - polling ${TAG}`, lines);
process.exit(0);
