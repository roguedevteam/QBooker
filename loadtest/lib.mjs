// Shared helpers for the QBooker load tests. Node 22, no extra dependencies: it borrows `pg` and
// `jsonwebtoken` from ../server/node_modules. Everything runs against the throwaway local Postgres
// (never Supabase) and a private API instance (default :4300).
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const pg = require("pg");
const jwt = require("jsonwebtoken");
pg.types.setTypeParser(1082, (v) => v);

export const BASE = (process.env.BASE_URL || "http://localhost:4300").replace(/\/$/, "");
export const JWT_SECRET = process.env.JWT_SECRET || "testsecret";
export const PG_CONF = { host: process.env.PGHOST || "/tmp/pgtest", port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || "qb_test", user: process.env.PGUSER || "postgres" };
export const API_PID_FILE = process.env.API_PID_FILE || "/tmp/load/api.pid";
export const API_LOG = process.env.API_LOG || "/tmp/load/api.log";
export const METRICS_FILE = process.env.METRICS_FILE || "/tmp/load/metrics.jsonl";

// Safety: this tool must only ever talk to the local throwaway database.
if (!String(PG_CONF.host).startsWith("/") && !["localhost", "127.0.0.1"].includes(PG_CONF.host)) throw new Error("loadtest refuses to run against a remote database");

export const db = new pg.Pool({ ...PG_CONF, max: 4 });
db.on("error", () => {});
export const sql = async (text, params) => (await db.query(text, params)).rows;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rid = (n = 8) => crypto.randomBytes(n).toString("hex");
export const today = () => new Date().toISOString().slice(0, 10);
export const randIp = () => `10.${1 + crypto.randomInt(250)}.${1 + crypto.randomInt(250)}.${1 + crypto.randomInt(250)}`;
export const deviceId = () => crypto.randomBytes(16).toString("base64url"); // 22 chars, matches DEVICE_RE
export const sign = (payload, expiresIn = "4h") => jwt.sign(payload, JWT_SECRET, { expiresIn });
export const ALLDAY = Array.from({ length: 48 }, (_, i) => i * 30);

export function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
export function summarize(lat) {
  return { n: lat.length, p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1), max: +(lat.length ? Math.max(...lat) : 0).toFixed(1) };
}

// One HTTP call; never throws. Returns { status, json, ms, error }.
export async function http(method, path, { token, body, ip, headers = {}, timeoutMs = 30000, raw } = {}) {
  const h = { ...headers };
  if (ip) h["x-forwarded-for"] = ip;
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, error: String(e.cause?.code || e.name || e.message), ms: performance.now() - t0 };
  }
}

// Fixture: one tenant with location, services (all licensed + open all day today), staff members.
// svc: { name, mode, slotMinutes, staffCount, bookingStaffCount, walkInStaffCount }
export async function seedTenant({ name = "lt", services, staffN = 1, onsiteOnly = false }) {
  const d = today();
  const code6 = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[crypto.randomInt(32)]).join("");
  const tid = (await sql(
    `insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name,onsite_only)
     values ($1,$2,1,$3,'card','active','Load','Test',$4) returning id`,
    [`lt-${name}-${rid(3)}`, `lt-${rid(5)}@example.com`, code6(), onsiteOnly]))[0].id;
  const lid = (await sql(`insert into locations (tenant_id,name,address,staff_access_code) values ($1,'Main','',$2) returning id`, [tid, `${code6()}-${rid(3)}`]))[0].id;
  await sql(`insert into location_codes (code,tenant_id,location_id) values ($1,$2,$3)`, [`QB-${code6()}`, tid, lid]);
  const svcs = [];
  for (const s of services) {
    const sid = (await sql(`insert into services (tenant_id,location_id,name,mode,slot_minutes) values ($1,$2,$3,$4,$5) returning id`,
      [tid, lid, s.name, s.mode || "hybrid", s.slotMinutes || 15]))[0].id;
    await sql(`insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status,start_date,end_date,scheduled_at)
               values ($1,$2,'month','Month',30,0,'active',$3::date - 1,$3::date + 28,now())`, [tid, sid, d]);
    await sql(`insert into service_daily_config (service_id,date,hours,staff_count,booking_staff_count,walkin_staff_count) values ($1,$2,$3,$4,$5,$6)`,
      [sid, d, s.hours || ALLDAY, s.staffCount ?? 3, s.bookingStaffCount ?? 1, s.walkInStaffCount ?? 2]);
    svcs.push({ id: sid, name: s.name });
  }
  const staff = [];
  for (let i = 0; i < staffN; i++) {
    const id = (await sql(`insert into staff_members (tenant_id,first_name,last_name,email) values ($1,'S',$2,$3) returning id`, [tid, `n${i}`, `lt-staff-${rid(5)}@example.com`]))[0].id;
    staff.push({ id, token: sign({ role: "staff", tenantId: tid, staffId: id }) });
  }
  return { tid, lid, services: svcs, staff, adminToken: sign({ role: "tenant_admin", tenantId: tid }), today: d };
}

// Run `total` async jobs with at most `conc` in flight.
export async function pool(total, conc, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(conc, total) }, async () => {
    while (true) { const i = next++; if (i >= total) return; await fn(i); }
  });
  await Promise.all(workers);
}

export async function pgActivity() {
  const r = await sql(`select state, count(*)::int n from pg_stat_activity where datname=$1 and pid<>pg_backend_pid() and application_name='' and backend_type='client backend' group by 1`, [PG_CONF.database]);
  // our own fixture pool also shows up; subtract it by application_name below if set. Report total + by state.
  const by = Object.fromEntries(r.map((x) => [x.state || "null", x.n]));
  return { total: r.reduce((a, x) => a + x.n, 0), by };
}

export function apiPid() { try { return Number(fs.readFileSync(API_PID_FILE, "utf8").trim()); } catch { return null; } }
export function rssMb(pid = apiPid()) {
  try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8")); return m ? +(Number(m[1]) / 1024).toFixed(1) : null; } catch { return null; }
}
export function logErrors(sinceBytes = 0) {
  try {
    const buf = fs.readFileSync(API_LOG);
    return buf.subarray(sinceBytes).toString().split("\n").filter((l) => /error|unhandled|exception|ECONN|fatal/i.test(l));
  } catch { return []; }
}
export function logSize() { try { return fs.statSync(API_LOG).size; } catch { return 0; } }

export async function waitHealthy(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const r = await http("GET", "/health", { timeoutMs: 2000 }); if (r.status === 200) return true; await sleep(250); }
  return false;
}

// Appends a section to RESULTS.md (set RESULTS_FILE to redirect). Also prints it.
export function report(title, lines) {
  const out = `\n### ${title}\n_${new Date().toISOString()}_\n\n${lines.join("\n")}\n`;
  console.log(out);
  fs.appendFileSync(process.env.RESULTS_FILE || new URL("./RESULTS.md", import.meta.url).pathname, out);
}
export const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];

// Samples the DB side every `ms`: connections held by the API (TCP clients; fixtures use the unix socket),
// how many are active/idle-in-transaction, and how many are blocked waiting on an advisory lock.
export function startPgSampler(ms = 250) {
  const samples = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const r = (await sql(`select count(*)::int total,
            count(*) filter (where state='active')::int active,
            count(*) filter (where state like 'idle in transaction%')::int idle_tx,
            count(*) filter (where wait_event_type='Lock' and wait_event='advisory')::int adv_wait
          from pg_stat_activity where datname=$1 and client_addr is not null`, [PG_CONF.database]))[0];
        samples.push(r);
      } catch { /* DB may be down (resilience test) */ }
      await sleep(ms);
    }
  })();
  return {
    samples,
    async stop() { stop = true; await loop; },
    summary() {
      const mx = (k) => samples.reduce((a, s) => Math.max(a, s[k]), 0);
      return { maxConns: mx("total"), maxActive: mx("active"), maxIdleTx: mx("idle_tx"), maxAdvisoryWaiters: mx("adv_wait"), samples: samples.length };
    },
  };
}

// Reads the instrumentation file written by instrument.mjs (rows since `sinceT`).
export function readMetrics(sinceT = 0) {
  try { return fs.readFileSync(METRICS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t >= sinceT); } catch { return []; }
}
export function metricsSummary(rows) {
  if (!rows.length) return {};
  const mx = (k) => rows.reduce((a, r) => Math.max(a, r[k]), 0);
  const tot = rows[rows.length - 1].queries - (rows[0].queries - rows[0].qps);
  return { seconds: rows.length, queries: tot, avgQps: +(tot / rows.length).toFixed(1), peakQps: mx("qps"), maxInflightQueries: mx("maxInflight"), lagP99Max: mx("lagP99"), lagMax: mx("lagMax"), rssMax: mx("rssMb"), failedQueries: rows[rows.length - 1].failed, poolErrors: rows[rows.length - 1].poolErrors, connectWaitMaxMs: mx("connectWaitMaxMs") };
}
