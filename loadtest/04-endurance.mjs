// Scenario 4 - endurance. Steady moderate load for DURATION_MIN minutes (default 12) with ever-changing client IPs/devices
// (so per-IP structures such as the rate-limit maps would show up as growth). Samples API RSS/heap/event-loop lag/handles
// (from instrument.mjs) and DB connections; compares first vs last third for latency drift; plants stale 'serving' tickets
// from past days to prove the closeStaleTickets sweep keeps working; checks the log for unhandled rejections.
import { http, seedTenant, sql, sleep, summarize, report, table, randIp, deviceId, startPgSampler, readMetrics, logErrors, logSize, apiPid, rssMb } from "./lib.mjs";

const MIN = Number(process.env.DURATION_MIN || 12);
const RPS_WORKERS = Number(process.env.WORKERS || 12);
const logStart = logSize();
const t = await seedTenant({ name: "endure", staffN: 2, services: [{ name: "Endurance Clinic", mode: "hybrid", slotMinutes: 1, staffCount: 80, bookingStaffCount: 5, walkInStaffCount: 70 }] }); // 2100 walk-ins per block
const svc = t.services[0]; const P = `/api/public/tenant/${t.tid}`;
const end = Date.now() + MIN * 60000; const t0 = Date.now();
const lat = []; const codes = {}; let stopped = false;
const rec = (kind, r) => { lat.push({ at: Date.now() - t0, kind, ms: r.ms }); const k = r.status || r.error; codes[k] = (codes[k] || 0) + 1; };

async function patient() {
  while (Date.now() < end) {
    const ip = randIp();
    const j = await http("POST", `${P}/services/${svc.id}/tickets`, { ip, body: { type: "walk_in", date: t.today, deviceId: deviceId() } }); rec("join", j);
    if (j.status === 200) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) { await sleep(1500 + Math.random() * 1000); rec("poll", await http("GET", `/api/public/ticket/${j.json.publicToken}`, { ip })); }
      if (Math.random() < 0.4) rec("leave", await http("POST", `/api/public/ticket/${j.json.publicToken}/leave`, { ip }));
    } else await sleep(1000);
    await sleep(Math.random() * 500);
  }
}
async function staff(i) {
  while (Date.now() < end) {
    const c = await http("POST", `/api/tenant/services/${svc.id}/call-next`, { token: t.staff[i].token, body: { roomLabel: `R${i}`, date: t.today, workType: "both" } }); rec("call", c);
    if (c.status === 200) { await sleep(500); rec("close", await http("POST", `/api/tenant/tickets/${c.json.ticket.id}/close`, { token: t.staff[i].token })); }
    rec("tickets", await http("GET", `/api/tenant/tickets`, { token: t.staff[i].token }));
    await sleep(1500);
  }
}
async function admin() { while (Date.now() < end) { rec("admin", await http("GET", `/api/tenant/dashboard/stats`, { token: t.adminToken })); await sleep(5000); } }
// plant stale serving tickets (yesterday) every minute: the sweep must close them
const planted = []; 
async function planter() {
  while (Date.now() < end) {
    const r = await sql(`insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,hour_block,visit_date,called_at) values ($1,$2,$3,'ZZ-'||floor(random()*1e6)::int,'walk_in','serving',480,current_date-1,now()-interval '1 day') returning id`, [t.tid, svc.id, t.lid]);
    planted.push(r[0].id); await sleep(60000);
  }
}
const sampler = startPgSampler(1000);
const tasks = [...Array.from({ length: RPS_WORKERS }, patient), staff(0), staff(1), admin(), planter()];
const mem = [];
const memLoop = (async () => { while (Date.now() < end) { mem.push({ at: Date.now() - t0, rss: rssMb() }); await sleep(15000); } })();
await Promise.all([...tasks, memLoop]); await sampler.stop();
await sleep(1000);

const rows = readMetrics(t0);
const third = (a, i) => a.slice(Math.floor((a.length * i) / 3), Math.floor((a.length * (i + 1)) / 3));
const thirds = [0, 1, 2].map((i) => third(rows, i));
const avg = (a, k) => a.length ? +(a.reduce((x, r) => x + r[k], 0) / a.length).toFixed(1) : 0;
const mx = (a, k) => a.reduce((x, r) => Math.max(x, r[k]), 0);
const mn = (a, k) => a.length ? a.reduce((x, r) => Math.min(x, r[k]), Infinity) : 0;
const latThird = (i) => { const from = (end - t0) * i / 3, to = (end - t0) * (i + 1) / 3; return summarize(lat.filter((l) => l.at >= from && l.at < to && l.kind === "poll").map((l) => l.ms)); };
const stale = (await sql(`select count(*)::int n from tickets where id = any($1) and status='serving'`, [planted]))[0].n;
const closedBySys = (await sql(`select count(*)::int n from tickets where id = any($1) and closed_by_system`, [planted]))[0].n;
const errs = logErrors(logStart);
const rssSlope = (mem[mem.length - 1].rss - mem[Math.floor(mem.length / 3)].rss) / ((mem[mem.length - 1].at - mem[Math.floor(mem.length / 3)].at) / 60000);
report(`Scenario 4 - endurance (${MIN} min)`, [
  `${RPS_WORKERS} patient workers + 2 staff + admin, ${lat.length} requests (~${(lat.length / (MIN * 60)).toFixed(0)} req/s), distinct random client IP/device each visit.`,
  `HTTP outcomes: ${JSON.stringify(codes)}`, "",
  ...table(["window", "RSS avg MB", "heap min MB (post-GC floor)", "heap max MB", "loop lag p99 max ms", "handles max", "poll latency p50/p95/p99 ms"],
    thirds.map((a, i) => [`third ${i + 1}`, avg(a, "rssMb"), mn(a, "heapMb"), mx(a, "heapMb"), mx(a, "lagP99"), mx(a, "handles"), (({ p50, p95, p99 }) => `${p50}/${p95}/${p99}`)(latThird(i))])), "",
  `RSS growth over the last two thirds: ${rssSlope.toFixed(2)} MB/min (start ${mem[0].rss} MB -> end ${mem[mem.length - 1].rss} MB).`,
  `DB connections held by API: max ${sampler.summary().maxConns}, idle-in-tx max ${sampler.summary().maxIdleTx}; failed queries ${rows.at(-1)?.failed}, pool errors ${rows.at(-1)?.poolErrors}.`,
  `closeStaleTickets: planted ${planted.length} stale 'serving' tickets from yesterday; still serving at end: ${stale}; closed_by_system: ${closedBySys}.`,
  `Server log errors / unhandled rejections: ${errs.length}${errs.length ? "\n```\n" + errs.slice(0, 5).join("\n") + "\n```" : ""}`,
]);
process.exit(0);
