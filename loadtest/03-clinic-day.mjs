// Scenario 3 - a compressed clinic day. DAY_S real seconds stand for 08:00-17:00 (simulated clock passed as clockMinutes).
// Actors, all through the public/staff HTTP API: walk-in patients (join, poll, some leave), booked patients (availability, book,
// poll, check in, some leave), 3 staff kiosks (poll, call-next, call-again, return-to-queue, no-show, close), an admin dashboard.
// At the end the day is drained and invariants are checked against the database. Exit code 1 if any invariant fails.
import { http, seedTenant, sql, sleep, summarize, report, table, randIp, deviceId, startPgSampler, readMetrics, metricsSummary, logErrors, logSize, rssMb } from "./lib.mjs";

const DAY_S = Number(process.env.DAY_S || 150);
const WALKINS = Number(process.env.WALKINS || 140);
const BOOKINGS = Number(process.env.BOOKINGS || 50);
const STAFF = 3;
const logStart = logSize();
const sim = (tMs) => Math.min(1020, Math.floor(480 + (tMs / 1000 / DAY_S) * 540)); // minutes since midnight
const SLOT = 10; // => 3 walk-ins per staff per half hour, bookings spaced 10 min
const t = await seedTenant({ name: "day", staffN: STAFF, services: [{ name: "Family Practice", mode: "hybrid", slotMinutes: SLOT, staffCount: 5, bookingStaffCount: 2, walkInStaffCount: 3 }] });
const svc = t.services[0];
const P = `/api/public/tenant/${t.tid}`;
const t0 = Date.now();
const nowSim = () => sim(Date.now() - t0);
const cnt = { joinOk: 0, joinFull: 0, bookOk: 0, bookFail: 0, leaves: 0, checkins: 0, calls: 0, callAgain: 0, returned: 0, noShow: 0, closed: 0, polls: 0 };
const codes = {}; const bump = (k, s) => { const key = `${k}:${s}`; codes[key] = (codes[key] || 0) + 1; };
const lat = { join: [], book: [], poll: [], call: [], close: [], tickets: [] };
const callsById = new Map(); const returnsById = new Map();
const myTickets = []; // {id?, token, number}
let stop = false; const bg = [];

// ---- walk-in patients: arrival times uniform over the day (busy mid-morning), each polls until done
async function walkIn() {
  await sleep(Math.random() * DAY_S * 1000 * 0.9);
  const dev = deviceId(), ip = randIp();
  const r = await http("POST", `${P}/services/${svc.id}/tickets`, { ip, body: { type: "walk_in", date: t.today, deviceId: dev, clockMinutes: nowSim() } });
  lat.join.push(r.ms); bump("join", r.status);
  if (r.status === 409) { cnt.joinFull++; return; }
  if (r.status !== 200) return;
  cnt.joinOk++;
  await patientLife(r.json.publicToken, ip, false);
}
async function booked() {
  await sleep(Math.random() * DAY_S * 1000 * 0.5);
  const ip = randIp(), dev = deviceId();
  const a = await http("GET", `${P}/services/${svc.id}/availability?date=${t.today}&clockMinutes=${nowSim()}`, { ip });
  const slots = a.json?.bookableSlots || [];
  if (!slots.length) { cnt.bookFail++; return; }
  const slot = slots[Math.floor(Math.random() * Math.min(slots.length, 12))];
  const r = await http("POST", `${P}/services/${svc.id}/tickets`, { ip, body: { type: "booked", date: t.today, slotTime: slot, deviceId: dev, clockMinutes: nowSim() } });
  lat.book.push(r.ms); bump("book", r.status);
  if (r.status !== 200) { cnt.bookFail++; return; }
  cnt.bookOk++;
  await patientLife(r.json.publicToken, ip, true);
}
async function patientLife(token, ip, isBooked) {
  myTickets.push(token);
  const leaveAt = Math.random() < 0.12 ? Date.now() + Math.random() * 40000 : Infinity; // ~12% give up
  let checkedIn = false;
  while (!stop) {
    const r = await http("GET", `/api/public/ticket/${token}`, { ip }); lat.poll.push(r.ms); cnt.polls++; bump("poll", r.status);
    if (r.status !== 200) return;
    const st = r.json.state;
    if (st !== "waiting") return; // called, closed, cancelled: done
    if (isBooked && !checkedIn && Math.random() < 0.15) { const c = await http("POST", `/api/public/ticket/${token}/check-in`, { ip }); bump("checkin", c.status); if (c.status === 200) { cnt.checkins++; checkedIn = true; } }
    if (Date.now() > leaveAt) { const l = await http("POST", `/api/public/ticket/${token}/leave`, { ip }); bump("leave", l.status); if (l.status === 200) cnt.leaves++; return; }
    await sleep(4000 + Math.random() * 2000);
  }
}
// ---- staff
async function staffKiosk(i) {
  const s = t.staff[i]; const room = `Room ${i + 1}`;
  const sleepSim = (min, max) => sleep((min + Math.random() * (max - min)) * 1000);
  bg.push((async () => { while (!stop) { const r = await http("GET", `/api/tenant/tickets`, { token: s.token }); lat.tickets.push(r.ms); bump("tickets", r.status); await sleep(4000); } })());
  while (!stop) {
    const c = await http("POST", `/api/tenant/services/${svc.id}/call-next`, { token: s.token, body: { roomLabel: room, date: t.today, clockMinutes: nowSim(), workType: "both" } });
    lat.call.push(c.ms); bump("callnext", c.status);
    if (c.status === 404) { await sleep(1500); continue; }       // nobody to call right now
    if (c.status !== 200) { await sleep(500); continue; }
    cnt.calls++;
    const id = c.json.ticket.id; callsById.set(id, (callsById.get(id) || 0) + 1);
    await sleepSim(1.5, 4);                                       // "seeing the patient"
    const roll = Math.random();
    if (roll < 0.08) { const r = await http("POST", `/api/tenant/tickets/${id}/call-again`, { token: s.token, body: { roomLabel: room } }); bump("callagain", r.status); cnt.callAgain++; await sleepSim(0.5, 1.5); }
    if (roll > 0.92) { const r = await http("POST", `/api/tenant/tickets/${id}/return-to-queue`, { token: s.token, body: { clockMinutes: nowSim() } }); bump("return", r.status); if (r.status === 200) { cnt.returned++; returnsById.set(id, (returnsById.get(id) || 0) + 1); } continue; }
    if (roll > 0.85) { const r = await http("POST", `/api/tenant/tickets/${id}/no-show`, { token: s.token }); bump("noshow", r.status); if (r.status === 200) cnt.noShow++; continue; }
    const cl = await http("POST", `/api/tenant/tickets/${id}/close`, { token: s.token }); lat.close.push(cl.ms); bump("close", cl.status); if (cl.status === 200) cnt.closed++;
  }
}
async function admin() {
  while (!stop) {
    const [a, b, c] = await Promise.all([http("GET", `/api/tenant/tickets`, { token: t.adminToken }), http("GET", `/api/tenant/dashboard/stats`, { token: t.adminToken }), http("GET", `/api/tenant/today?serviceId=${svc.id}&clockMinutes=${nowSim()}`, { token: t.adminToken })]);
    bump("admin", a.status); bump("admin", b.status); bump("admin", c.status);
    await sleep(10000);
  }
}

const sampler = startPgSampler(250);
const m0 = Date.now();
const people = [...Array.from({ length: WALKINS }, walkIn), ...Array.from({ length: BOOKINGS }, booked)];
const staffRuns = Array.from({ length: STAFF }, (_, i) => staffKiosk(i));
bg.push(admin());
await Promise.all(people);                          // all patients have arrived and finished waiting or been called
// drain: let staff finish what is left (up to 90 s)
for (let i = 0; i < 90; i++) {
  const left = (await sql(`select count(*)::int n from tickets where service_id=$1 and status in ('waiting','booked','serving') and not (type='booked' and slot_time>$2)`, [svc.id, 1020]))[0].n;
  if (left === 0) break; await sleep(1000);
}
stop = true; await Promise.all([...staffRuns, ...bg]); await sampler.stop();
const mm = metricsSummary(readMetrics(m0));

// ---- invariants
const inv = [];
const check = (name, ok, detail = "") => inv.push([name, ok ? "PASS" : "**FAIL**", detail]);
const tix = await sql(`select * from tickets where service_id=$1`, [svc.id]);
const byStatus = tix.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
check("ticket count equals successful joins+bookings", tix.length === cnt.joinOk + cnt.bookOk, `db ${tix.length} vs client ${cnt.joinOk + cnt.bookOk}`);
const dup = await sql(`select ticket_number, count(*)::int n from tickets where service_id=$1 group by 1 having count(*)>1`, [svc.id]);
check("no duplicate ticket numbers", dup.length === 0, `${dup.length} duplicates`);
const bad = tix.filter((x) => (x.status === "serving" && (!x.called_at || x.finished_at)) || (x.status === "completed" && !x.called_at) || (["waiting", "booked"].includes(x.status) && x.called_at));
check("every ticket in a coherent state (serving has called_at & no finished_at; completed has called_at; waiting/booked never called)", bad.length === 0, `${bad.length} incoherent: ${bad.slice(0, 3).map((x) => x.ticket_number + ":" + x.status).join(",")}`);
const stuck = tix.filter((x) => x.status === "serving");
check("no ticket left 'serving'", stuck.length === 0, `${stuck.length} left`);
const twice = [...callsById].filter(([id, n]) => n - (returnsById.get(id) || 0) > 1);
check("no ticket served twice (calls minus returns-to-queue <= 1 per ticket)", twice.length === 0, `${twice.length} tickets called more than once without being returned`);
const doneNoCall = tix.filter((x) => x.status === "completed" && !callsById.has(x.id));
check("every completed ticket was called via call-next", doneNoCall.length === 0, `${doneNoCall.length}`);
const wb = await sql(`select hour_block, count(*)::int n from tickets where service_id=$1 and type='walk_in' and status<>'cancelled' group by 1 order by 2 desc limit 1`, [svc.id]);
check("walk-in capacity per half-hour block never exceeded (budget 9)", !wb[0] || wb[0].n <= 9, `max ${wb[0]?.n ?? 0} in block ${wb[0]?.hour_block}`);
const bs = await sql(`select slot_time, count(*)::int n from tickets where service_id=$1 and type='booked' and status<>'cancelled' group by 1 order by 2 desc limit 1`, [svc.id]);
check("bookings per slot never exceed booking staff (2)", !bs[0] || bs[0].n <= 2, `max ${bs[0]?.n ?? 0} at slot ${bs[0]?.slot_time}`);
const st = await http("GET", `/api/tenant/dashboard/stats`, { token: t.adminToken });
const dbStats = Object.fromEntries((await sql(`select status, count(*)::int n from tickets where tenant_id=$1 and visit_date=$2 group by 1`, [t.tid, t.today])).map((r) => [r.status, r.n]));
const sameStats = Object.keys({ ...st.json.stats, ...dbStats }).every((k) => (st.json.stats[k] || 0) === (dbStats[k] || 0));
check("dashboard stats equal database counts", sameStats, JSON.stringify(st.json.stats));
const aud = (await sql(`select count(*) filter (where message like '%joined the%')::int j, count(*) filter (where message like '%booked Family%')::int b, count(*) filter (where message like '%called forward%')::int c from audit_log where tenant_id=$1`, [t.tid]))[0];
check("audit log matches client counts (joins, bookings, calls)", aud.j === cnt.joinOk && aud.b === cnt.bookOk && aud.c === cnt.calls, `audit j/b/c ${aud.j}/${aud.b}/${aud.c} vs client ${cnt.joinOk}/${cnt.bookOk}/${cnt.calls}`);
const locks = (await sql(`select count(*)::int n from pg_locks where locktype='advisory'`))[0].n;
const idleTx = (await sql(`select count(*)::int n from pg_stat_activity where datname=current_database() and state like 'idle in transaction%' and client_addr is not null`))[0].n;
check("no advisory locks or idle-in-transaction sessions left", locks === 0 && idleTx === 0, `advisory ${locks}, idle-in-tx ${idleTx}`);
const fivexx = Object.entries(codes).filter(([k]) => /:(5\d\d|0)$/.test(k));
check("no 5xx / connection errors from the API", fivexx.length === 0, JSON.stringify(fivexx));
const errs = logErrors(logStart);
check("server log clean", errs.length === 0, errs.slice(0, 3).join(" | "));
const failed = inv.some((r) => r[1].includes("FAIL"));

report("Scenario 3 - mixed clinic day", [
  `Compressed day: ${DAY_S}s real for 08:00-17:00, ${WALKINS} walk-in attempts, ${BOOKINGS} booking attempts, ${STAFF} staff kiosks + admin dashboard.`,
  ...table(["activity", "count"], Object.entries(cnt).map(([k, v]) => [k, v])),
  "", `Final ticket states: ${JSON.stringify(byStatus)}`, `HTTP outcomes: ${JSON.stringify(codes)}`, "",
  ...table(["call", "n", "p50", "p95", "p99", "max (ms)"], Object.entries(lat).map(([k, v]) => { const s = summarize(v); return [k, s.n, s.p50, s.p95, s.p99, s.max]; })),
  "", `DB: max conns ${sampler.summary().maxConns}, max advisory waiters ${sampler.summary().maxAdvisoryWaiters}; API: ${mm.avgQps} qps avg / ${mm.peakQps} peak, loop lag max ${mm.lagMax} ms, RSS ${rssMb()} MB.`,
  "", "**Invariants**", ...table(["check", "result", "detail"], inv),
]);
process.exit(failed ? 1 : 0);
