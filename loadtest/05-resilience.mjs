// Scenario 5 - DB resilience. (R1) restart Postgres in the middle of steady load: the API must not crash, must answer with clean
// JSON 5xx (ideally 503) while the DB is away and must recover by itself. (R2) pool exhaustion: hold the per-service advisory lock
// from outside so joins pile up on it; unrelated requests must still be answered promptly and the stuck ones must fail fast.
// Needs permission to run `su postgres -c pg_ctl restart` (the throwaway sandbox DB only). Starts its own API via start-api.sh when dead.
import { execSync } from "child_process";
import { http, seedTenant, sql, sleep, summarize, report, table, randIp, deviceId, apiPid, logErrors, logSize, waitHealthy, rssMb, db, PG_CONF } from "./lib.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = [];
const logStart = logSize();
const pidStart = apiPid();

const t = await seedTenant({ name: "resil", staffN: 1, services: [{ name: "Resil Clinic", mode: "hybrid", slotMinutes: 5, staffCount: 60, bookingStaffCount: 5, walkInStaffCount: 50 }] });
const svc = t.services[0];
await sql(`with ins as (insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,hour_block,visit_date)
          select $1,$2,$3,'RC-'||lpad(g::text,3,'0'),'walk_in','waiting',480,$4::date from generate_series(1,50) g returning id, ticket_number)
  insert into ticket_web_access (token, ticket_id, tenant_id) select substr(md5(id::text)||md5(ticket_number),1,24), id, $1 from ins`, [t.tid, svc.id, t.lid, t.today]);
const tokens = (await sql(`select token from ticket_web_access where tenant_id=$1`, [t.tid])).map((r) => r.token);

// ---------------- R1: restart Postgres under load ----------------
const PHASE_S = { warm: 8, outageMax: 60, after: 15 };
const timeline = []; // {sec, status, json, ms, kind}
let stop = false; const t0 = Date.now();
const kinds = ["poll", "poll", "join", "staff"];
async function worker() {
  while (!stop) {
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    let r;
    if (kind === "poll") r = await http("GET", `/api/public/ticket/${tokens[Math.floor(Math.random() * tokens.length)]}`, { ip: randIp(), timeoutMs: 20000 });
    else if (kind === "join") r = await http("POST", `/api/public/tenant/${t.tid}/services/${svc.id}/tickets`, { ip: randIp(), body: { type: "walk_in", date: t.today, deviceId: deviceId() }, timeoutMs: 20000 });
    else r = await http("GET", `/api/tenant/tickets`, { token: t.staff[0].token, ip: randIp(), timeoutMs: 20000 });
    timeline.push({ sec: Math.floor((Date.now() - t0) / 1000), kind, status: r.status, err: r.error, jsonOk: r.status === 0 ? null : !!r.json, ms: r.ms });
    await sleep(50);
  }
}
const workers = Array.from({ length: 8 }, worker);
await sleep(PHASE_S.warm * 1000);
const restartAt = Math.floor((Date.now() - t0) / 1000);
console.log("restarting postgres at t=" + restartAt);
const rs0 = Date.now();
const PGCTL = `/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgtest/data -o '-p ${PG_CONF.port} -k /tmp/pgtest' -l /tmp/pgtest/log`;
const OUTAGE_S = Number(process.env.OUTAGE_S || 12); // 0 = plain fast restart (sub-second blip); >0 = stop, stay down this long, start
if (OUTAGE_S > 0) {
  execSync(`su postgres -c "${PGCTL} stop -m fast -w -t 60"`, { stdio: "ignore" });
  await sleep(OUTAGE_S * 1000);
  execSync(`su postgres -c "${PGCTL} start -w -t 60"`, { stdio: "ignore" });
} else execSync(`su postgres -c "${PGCTL} restart -w -t 60"`, { stdio: "ignore" });
const restartSecs = (Date.now() - rs0) / 1000;
const pgBackAt = Math.floor((Date.now() - t0) / 1000);
// wait for traffic to be healthy again
let recoveredAt = null;
for (let i = 0; i < PHASE_S.outageMax; i++) {
  await sleep(1000);
  const sec = Math.floor((Date.now() - t0) / 1000);
  const recent = timeline.filter((x) => x.sec >= sec - 2 && x.sec <= sec);
  if (recent.length >= 5 && recent.every((x) => x.status === 200 || x.status === 409)) { recoveredAt = sec; break; }
}
await sleep(PHASE_S.after * 1000);
stop = true; await Promise.all(workers);
const outage = timeline.filter((x) => x.sec >= restartAt && x.sec <= (recoveredAt ?? 9999));
const by = (arr) => arr.reduce((a, x) => { const k = x.status || x.err; a[k] = (a[k] || 0) + 1; return a; }, {});
const non200 = outage.filter((x) => x.status !== 200 && x.status !== 409); // 409 = join refused because the day is full (expected)
const last5xx = Math.max(-1, ...timeline.filter((x) => x.status >= 500 || x.status === 0).map((x) => x.sec));
const pidNow = apiPid();
const healthy = await waitHealthy(5000);
lines.push(`**R1. Postgres ${OUTAGE_S > 0 ? `down for ${OUTAGE_S} s` : "restarted"} under ~50 req/s of mixed traffic**`);
lines.push(...table(["metric", "value"], [
  [OUTAGE_S > 0 ? `Postgres stopped for ${OUTAGE_S}s then started: took` : "pg_ctl restart took", `${restartSecs.toFixed(1)} s`],
  ["API process survived (same pid, answers /health)", `${alive(pidNow)} / ${healthy} (pid ${pidStart} -> ${pidNow})`],
  ["all statuses seen from restart until recovery", JSON.stringify(by(outage))],
  ["non-200 responses with a JSON body", `${non200.filter((x) => x.jsonOk).length} of ${non200.length}`],
  ["traffic fully healthy again at", recoveredAt === null ? "NEVER (within 60 s)" : `${recoveredAt - pgBackAt} s after Postgres was back (${recoveredAt - restartAt} s after restart began)`],
  ["last 5xx/connection failure seen", last5xx < 0 ? "none" : `${last5xx - pgBackAt} s after Postgres was back`],
  ["slowest response during outage", `${Math.max(...outage.map((x) => x.ms)).toFixed(0)} ms`],
  ["API RSS after", `${rssMb()} MB`],
]));
const errs1 = logErrors(logStart);
lines.push(`\nServer log lines matching error/unhandled: ${errs1.length}`);
if (errs1.length) lines.push("```\n" + [...new Set(errs1.map((l) => l.slice(0, 160)))].slice(0, 8).join("\n") + "\n```");

// ---------------- R2: pool exhaustion via advisory lock held from outside ----------------
if (!alive(apiPid())) { lines.push("\nAPI was dead after R1 - R2 skipped (restart with start-api.sh)."); report("Scenario 5 - DB resilience", lines); process.exit(0); }
const lockClient = await db.connect();
await lockClient.query("begin");
await lockClient.query("select pg_advisory_xact_lock(hashtext($1))", [`ticket|${svc.id}|${t.today}`]);
const stuck = Array.from({ length: 40 }, () => http("POST", `/api/public/tenant/${t.tid}/services/${svc.id}/tickets`, { ip: randIp(), body: { type: "walk_in", date: t.today, deviceId: deviceId() }, timeoutMs: 40000 }));
await sleep(1500);
const other = []; // unrelated traffic while the pool is clogged
for (let i = 0; i < 6; i++) { other.push(await http("GET", `/api/public/ticket/${tokens[i]}`, { ip: randIp(), timeoutMs: 40000 })); await sleep(500); }
const health = await http("GET", "/health", { timeoutMs: 5000 });
const firstStuck = await Promise.race([Promise.all(stuck).then((x) => ({ done: true, x })), sleep(35000).then(() => ({ done: false }))]);
const heldFor = 1.5 + 3;
await lockClient.query("rollback"); lockClient.release();
const settled = firstStuck.done ? firstStuck.x : await Promise.all(stuck);
const after = await http("GET", `/api/public/ticket/${tokens[0]}`, { ip: randIp() });
lines.push("\n**R2. Pool exhaustion: 40 joins blocked on a held per-service advisory lock (pool max 10 by default)**");
lines.push(...table(["metric", "value"], [
  ["unrelated patient polls issued while clogged (statuses / latency ms)", `${JSON.stringify(by(other))} / ${JSON.stringify(summarize(other.map((o) => o.ms)))}`],
  ["/health while clogged", `${health.status} in ${health.ms.toFixed(0)} ms (does not touch the DB)`],
  ["blocked joins: results after waiting up to 35 s with the lock still held", firstStuck.done ? JSON.stringify(by(firstStuck.x)) : "STILL HANGING after 35 s (lock released manually)"],
  ["blocked joins: slowest", `${Math.max(...settled.map((x) => x.ms)).toFixed(0)} ms`],
  ["after releasing the lock: normal poll", `${after.status} in ${after.ms.toFixed(0)} ms`],
]));
const errs = logErrors(logStart);
lines.push(`\nServer log lines matching error/unhandled (whole scenario): ${errs.length}`);
report("Scenario 5 - DB resilience", lines);
process.exit(0);
