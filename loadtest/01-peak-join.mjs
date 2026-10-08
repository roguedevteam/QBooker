// Scenario 1 - peak join. N patients (distinct device id + distinct client IP via X-Forwarded-For, as with TRUST_PROXY=1)
// join one hybrid service within RAMP_S seconds through the public API; then an over-capacity burst and an abusive client.
import { http, seedTenant, sql, sleep, summarize, report, table, randIp, deviceId, startPgSampler, readMetrics, metricsSummary, logErrors, logSize, rssMb } from "./lib.mjs";

const N = Number(process.env.PATIENTS || 250);
const RAMP_S = Number(process.env.RAMP_S || 120);
const logStart = logSize();
const lines = [];

async function patientsJoin(t, svc, n, rampS, label) {
  const lat = []; const codes = {}; const tickets = [];
  const t0 = Date.now();
  const jobs = Array.from({ length: n }, (_, i) => (async () => {
    await sleep(Math.random() * rampS * 1000);
    const r = await http("POST", `/api/public/tenant/${t.tid}/services/${svc.id}/tickets`, { ip: randIp(), body: { type: "walk_in", date: t.today, deviceId: deviceId() } });
    lat.push(r.ms); const k = r.status || r.error; codes[k] = (codes[k] || 0) + 1;
    if (r.status === 200) {
      tickets.push({ no: r.json.ticket.ticket_number, token: r.json.publicToken });
      const p = await http("GET", `/api/public/ticket/${r.json.publicToken}`, { ip: randIp() }); // first poll right after joining
      lat.push(p.ms);
    }
  })());
  await Promise.all(jobs);
  return { lat, codes, tickets, secs: (Date.now() - t0) / 1000 };
}

// ---- A: everyone fits (budget 300 per half hour) ---
const A = await seedTenant({ name: "peak", services: [{ name: "Big Day Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 60, bookingStaffCount: 5, walkInStaffCount: 50 }] }); // 50 x 6 = 300 walk-ins per block
const sampler = startPgSampler(200);
const m0 = Date.now();
const a = await patientsJoin(A, A.services[0], N, RAMP_S, "A");
await sampler.stop();
const mA = metricsSummary(readMetrics(m0));
const dbA = (await sql(`select count(*)::int n, count(distinct ticket_number)::int distinct_nums, max((substring(ticket_number from '-(\\d+)$'))::int) maxn from tickets where service_id=$1`, [A.services[0].id]))[0];
const blocksA = await sql(`select hour_block, count(*)::int n from tickets where service_id=$1 group by 1`, [A.services[0].id]);
const budgetA = 300;
const locks = (await sql(`select count(*)::int n from pg_locks where locktype='advisory' and not granted`))[0].n;
lines.push(`**A. ${N} patients ramped over ${RAMP_S}s, capacity ${budgetA}/half-hour block** (generator shares the 2 CPUs with API+DB)`);
lines.push(...table(["metric", "value"], [
  ["HTTP results", JSON.stringify(a.codes)],
  ["join latency ms (incl. follow-up poll)", JSON.stringify(summarize(a.lat))],
  ["tickets in DB / distinct numbers / highest number", `${dbA.n} / ${dbA.distinct_nums} / ${dbA.maxn}`],
  ["tickets per block (max vs budget)", `${Math.max(...blocksA.map((b) => b.n))} vs ${budgetA}`],
  ["DB connections (API) max / max active / max idle-in-tx", `${sampler.summary().maxConns} / ${sampler.summary().maxActive} / ${sampler.summary().maxIdleTx}`],
  ["backends blocked on advisory lock, max seen", sampler.summary().maxAdvisoryWaiters],
  ["ungranted advisory locks after run", locks],
  ["API queries / avg qps / peak qps / max in-flight", `${mA.queries} / ${mA.avgQps} / ${mA.peakQps} / ${mA.maxInflightQueries}`],
  ["event-loop lag p99 max / max ms", `${mA.lagP99Max} / ${mA.lagMax}`],
]));

// ---- B: burst over capacity: budget 150, 250 patients in 10 s -> exactly 150 succeed, the rest 409 'full' ---
const B = await seedTenant({ name: "peakfull", services: [{ name: "Small Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 30, bookingStaffCount: 5, walkInStaffCount: 25 }] }); // 25 x 6 = 150
const sB = startPgSampler(100);
const b = await patientsJoin(B, B.services[0], N, 10, "B");
await sB.stop();
const dbB = (await sql(`select count(*)::int n, count(distinct ticket_number)::int d from tickets where service_id=$1 and status<>'cancelled'`, [B.services[0].id]))[0];
const full = await http("POST", `/api/public/tenant/${B.tid}/services/${B.services[0].id}/tickets`, { ip: randIp(), body: { type: "walk_in", date: B.today, deviceId: deviceId() } });
lines.push(`\n**B. ${N} patients in a 10 s burst, capacity 150**`);
lines.push(...table(["metric", "value"], [
  ["HTTP results", JSON.stringify(b.codes)],
  ["latency ms", JSON.stringify(summarize(b.lat))],
  ["tickets in DB / distinct (must be <=150 and equal)", `${dbB.n} / ${dbB.d}`],
  ["a further join afterwards", `${full.status} ${full.json?.reason || ""}`],
  ["max advisory waiters / max conns", `${sB.summary().maxAdvisoryWaiters} / ${sB.summary().maxConns}`],
]));

// ---- C: abusive single client (one IP) ---
const C = await seedTenant({ name: "abuse", services: [{ name: "Abuse Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 30, bookingStaffCount: 5, walkInStaffCount: 25 }] });
const ip = randIp(); const abuseCodes = {}; let firstLimit = null;
for (let i = 0; i < 60; i++) {
  const r = await http("POST", `/api/public/tenant/${C.tid}/services/${C.services[0].id}/tickets`, { ip, body: { type: "walk_in", date: C.today, deviceId: deviceId() } });
  const k = `${r.status}${r.json?.reason ? ":" + r.json.reason : ""}`; abuseCodes[k] = (abuseCodes[k] || 0) + 1;
  if (r.status === 429 && !r.json?.reason && firstLimit === null) firstLimit = i + 1;
}
// same device repeatedly from rotating IPs
const dev = deviceId(); const devCodes = {};
for (let i = 0; i < 6; i++) {
  const r = await http("POST", `/api/public/tenant/${C.tid}/services/${C.services[0].id}/tickets`, { ip: randIp(), body: { type: "walk_in", date: C.today, deviceId: dev } });
  const k = `${r.status}${r.json?.reason ? ":" + r.json.reason : ""}`; devCodes[k] = (devCodes[k] || 0) + 1;
}
// a polling-abuser: 200 GETs of one token from one IP in a few seconds
const tk = (await sql(`select token from ticket_web_access where tenant_id=$1 limit 1`, [C.tid]))[0]?.token;
const pollCodes = {}; const pip = randIp();
for (let i = 0; i < 120; i++) { const r = await http("GET", `/api/public/ticket/${tk}`, { ip: pip }); pollCodes[r.status] = (pollCodes[r.status] || 0) + 1; }
lines.push(`\n**C. Abuse**`);
lines.push(...table(["case", "result"], [
  ["60 joins from ONE ip, new device id each", JSON.stringify(abuseCodes) + ` (IP rate limit first bit at request #${firstLimit})`],
  ["6 joins, same device id, rotating IPs", JSON.stringify(devCodes)],
  ["120 polls of one token from one ip in a burst (limit 30/min per token)", JSON.stringify(pollCodes)],
]));

// ---- D: thundering herd - everyone presses Join in the same instant (one service, one advisory lock) ---
const D = await seedTenant({ name: "herd", services: [{ name: "Herd Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 60, bookingStaffCount: 5, walkInStaffCount: 50 }] });
const sD = startPgSampler(50); const mD = Date.now();
const d = await patientsJoin(D, D.services[0], N, 0, "D");
await sD.stop();
const dbD = (await sql(`select count(*)::int n, count(distinct ticket_number)::int dn from tickets where service_id=$1`, [D.services[0].id]))[0];
const mDs = metricsSummary(readMetrics(mD));
lines.push(`\n**D. Thundering herd: ${N} patients in the same instant, one service**`);
lines.push(...table(["metric", "value"], [
  ["HTTP results", JSON.stringify(d.codes)],
  ["latency ms (join + poll)", JSON.stringify(summarize(d.lat))],
  ["tickets / distinct numbers", `${dbD.n} / ${dbD.dn}`],
  ["max conns / max advisory waiters", `${sD.summary().maxConns} / ${sD.summary().maxAdvisoryWaiters}`],
  ["max in-flight queries / pool connect wait max ms / event-loop lag max ms", `${mDs.maxInflightQueries} / ${mDs.connectWaitMaxMs} / ${mDs.lagMax}`],
]));

const errs = logErrors(logStart);
lines.push(`\nServer log errors during scenario: ${errs.length}${errs.length ? "\n```\n" + errs.slice(0, 10).join("\n") + "\n```" : ""}. API RSS now ${rssMb()} MB.`);
report("Scenario 1 - peak join", lines);
process.exit(0);
