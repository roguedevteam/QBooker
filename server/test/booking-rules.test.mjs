// QBooker booking-rules suite: server-trusted time, DST, per-location time zones, ticket numbers, licence freshness, currency config.
//   node --test server/test/booking-rules.test.mjs
//
// Self-contained like gaps.test.mjs: starts its OWN API (ports 4400-4499) with the TEST CLOCK (NODE_ENV=test) against the
// throwaway Postgres and moves the server's clock with POST /api/system/test-now. Everything it creates is named `br-<run>-...`.
// A scratch database (qb_br_<run>) is created and dropped for the migration/dedupe test. Never touches :4100 or Supabase.
//
// Sections
//   A. server-trusted time: a client's clockMinutes / nowMinutes is ignored; past slots and past walk-in blocks are refused
//   B. DST: nonexistent (skipped) and repeated wall-clock hours in London, New York, Lord Howe (30-minute shift) and Auckland
//   C. per-location time zones: London / New York / Kolkata (+5:30) / Lord Howe / Auckland side by side across midnight
//   D. API + database validation of time zones, tenant defaults, currency and billing config
//   E. ticket numbers: unambiguous per location-day, stable prefixes, unique index, migration dedupe
//   F. licence status is never stale (every read path, plus the sweep)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { signupV, verifyEmail } from './signup-helper.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(SERVER_DIR, '..');
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const JWT_SECRET = 'br-test-secret-' + 'x'.repeat(24);
const SYSTEM_PASSWORD = 'adminpass';
const PG = {
  host: process.env.PGHOST || '/tmp/pgtest', port: process.env.PGPORT || '5433',
  db: process.env.PGDATABASE || 'qb_test', user: process.env.PGUSER || 'postgres',
};
const DATABASE_URL = process.env.DATABASE_URL || `postgresql://${PG.user}@localhost:${PG.port}/${PG.db}`;
const RUN = crypto.randomBytes(3).toString('hex');
const rnd = () => crypto.randomBytes(4).toString('hex');
const ri = (n) => crypto.randomInt(n);
const randIp = () => `10.${ri(250) + 1}.${ri(250) + 1}.${ri(250) + 1}`;
const ALLDAY = Array.from({ length: 48 }, (_, i) => i * 30);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function sql(query, db = PG.db) {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const sqlJson = (query, db) => JSON.parse(sql(`select coalesce(json_agg(t),'[]'::json) from (${query}) t`, db));

function freePort(from = 4400, to = 4499) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > to) return reject(new Error('no free port in 4400-4499'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(from + ri(40));
  });
}
async function startServer({ env = {}, label }) {
  const port = await freePort();
  const logFile = `/tmp/gaps/${label}-br-${RUN}.log`;
  fs.mkdirSync('/tmp/gaps', { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const baseEnv = { ...process.env };
  delete baseEnv.NODE_ENV; delete baseEnv.QB_TEST_NOW; delete baseEnv.QB_TEST_NOW_FROZEN;
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'e2e/dns-stub.mjs'), 'src/index.js'], {
    cwd: SERVER_DIR, stdio: ['ignore', out, out],
    env: { ...baseEnv, PORT: String(port), DATABASE_URL, DATABASE_SSL: 'false', JWT_SECRET, SYSTEM_ADMIN_PASSWORD_HASH: bcrypt.hashSync(SYSTEM_PASSWORD, 4), CORS_ORIGIN: 'http://localhost:5173', TRUST_PROXY: '1', ...env },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, port, child, logFile }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server ${label} did not start; see ${logFile}`);
}
const stopServer = (s) => new Promise((resolve) => { if (!s?.child || s.child.exitCode !== null) return resolve(); s.child.once('exit', resolve); s.child.kill('SIGTERM'); setTimeout(() => s.child.kill('SIGKILL'), 3000).unref(); });

let srv;
async function api(method, p, { token, body, ip } = {}) {
  const h = { 'x-forwarded-for': ip || randIp() };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(srv.base + p, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const get = (p, o) => api('GET', p, o);
const post = (p, body, o = {}) => api('POST', p, { ...o, body });
const put = (p, body, o = {}) => api('PUT', p, { ...o, body });
const patch = (p, body, o = {}) => api('PATCH', p, { ...o, body });
const del = (p, o) => api('DELETE', p, o);

const createdTenants = [];
before(async () => { srv = await startServer({ label: 'srv', env: { NODE_ENV: 'test', QB_TEST_NOW: '2026-10-24T12:00:00Z' } }); });
after(async () => {
  try {
    const t = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json?.token;
    if (t) for (const id of createdTenants) await del(`/api/system/tenants/${id}`, { token: t });
  } catch { /* best effort */ }
  await stopServer(srv);
});

// ------------------------------------------------------------------ fixtures
let sysTok;
const systemToken = async () => (sysTok ||= (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token);
// Moves the server's clock. frozen=true stops it ticking (for exact-boundary assertions).
async function at(iso, { frozen = true } = {}) {
  const r = await post('/api/system/test-now', { now: iso, frozen }, { token: await systemToken() });
  assert.equal(r.status, 200, `test-now failed: ${r.text}`);
}
async function signup(label = 't', { locations = [{ name: 'Main' }], services = [{ name: 'Dental Care', locationIndex: 0 }] } = {}) {
  const email = `br-${RUN}-${label}-${rnd()}@example.com`;
  const r = await signupV(post, { businessName: `br-${label}-${rnd()}`, firstName: 'Br', lastName: 'Tester', email, locations, services });
  assert.equal(r.status, 200, `signup failed: ${r.text}`);
  createdTenants.push(r.json.tenant.id);
  const v = await post('/api/auth/admin/verify-otp', { email, code: r.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  const token = v.json.token;
  const locs = (await get('/api/tenant/locations', { token })).json.locations;
  const svcs = (await get('/api/tenant/services', { token })).json.services;
  return { email, token, id: r.json.tenant.id, locations: locs, services: svcs };
}
async function newLocation(t, name, timezone) {
  const r = await post('/api/tenant/locations', { name, ...(timezone ? { timezone } : {}) }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  return r.json.location;
}
async function newService(t, locationId, name, extra = {}) {
  const r = await post('/api/tenant/services', { name, locationId }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  if (Object.keys(extra).length) { const p = await patch(`/api/tenant/services/${r.json.service.id}`, extra, { token: t.token }); assert.equal(p.status, 200, p.text); return p.json.service; }
  return r.json.service;
}
const putDay = (t, svcId, date, o = {}) => put(`/api/tenant/services/${svcId}/daily-config`,
  { date, hours: ALLDAY, staffCount: 3, bookingStaffCount: 2, walkInStaffCount: 1, ...o }, { token: t.token });
async function buyLicence(t, svcId, planId) {
  const r = await post(`/api/tenant/services/${svcId}/licenses`, { planId, paymentMethod: 'card' }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  return r.json.license;
}
// Buy + schedule a licence and set hours on each of `days` dates from `start`. The server clock must be at a moment when `start` is not yet past.
async function goLive(t, svc, { plan = 'week', start, days = 1, hours = ALLDAY, staff = {} } = {}) {
  const lic = await buyLicence(t, svc.id, plan);
  const s = await patch(`/api/tenant/services/${svc.id}/licenses/${lic.id}`, { startDate: start }, { token: t.token });
  assert.equal(s.status, 200, `schedule failed: ${s.text}`);
  for (let i = 0; i < days; i++) {
    const r = await putDay(t, svc.id, addDays(start, i), { hours, ...staff });
    assert.equal(r.status, 200, `putDay failed: ${r.text}`);
  }
  return s.json.license;
}
const P = (t) => `/api/public/tenant/${t.id}`;
const join = (t, svcId, body) => post(`${P(t)}/services/${svcId}/tickets`, body);
const walkIn = (t, svcId, date, extra = {}) => join(t, svcId, { type: 'walk_in', date, ...extra });
const booked = (t, svcId, date, slotTime, extra = {}) => join(t, svcId, { type: 'booked', date, slotTime, ...extra });
const avail = async (t, svcId, date, query = '') => (await get(`${P(t)}/services/${svcId}/availability?date=${date}${query}`)).json;
async function addStaff(t) {
  const email = `br-staff-${RUN}-${rnd()}@example.com`;
  const r = await post('/api/tenant/staff', { firstName: 'Sam', lastName: 'Staff', email }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  const o = await post('/api/auth/staff/request-otp', { email });
  const v = await post('/api/auth/staff/verify-otp', { email, code: o.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  return { token: v.json.token };
}
const callNext = (tok, svcId, date, o = {}) => post(`/api/tenant/services/${svcId}/call-next`, { roomLabel: 'Room 1', date, ...o }, { token: tok });
const ribbon = async (t, svcId) => (await get(`/api/tenant/today?serviceId=${svcId}`, { token: t.token })).json;
// Status of one licence (signup also creates a starter licence per service, so look it up by id).
const licStatus = async (t, svcId, licId) => (await get(`/api/tenant/services/${svcId}/licenses`, { token: t.token })).json.licenses.find((l) => l.id === licId)?.status;

// =====================================================================================
// A. SERVER-TRUSTED TIME
// =====================================================================================
describe('A. the server decides what time it is; a client clockMinutes / nowMinutes is ignored', () => {
  const D = '2026-11-10'; // GMT: UTC == London
  let t, svc, staff;
  before(async () => {
    await at(`${D}T06:00:00Z`);
    t = await signup('trust');
    svc = t.services[0];
    await goLive(t, svc, { plan: 'day', start: D, hours: [540, 570, 600, 630], staff: { staffCount: 4, bookingStaffCount: 2, walkInStaffCount: 2 } });
    staff = await addStaff(t);
  });

  it('a slot that has started is refused for today; the slot of the current minute is still bookable; later ones too', async () => {
    await at(`${D}T09:20:30Z`); // 09:20:30 -> minute 560
    const past = await booked(t, svc.id, D, 540);
    assert.equal(past.status, 409, past.text); assert.equal(past.json.reason, 'slot_passed');
    assert.equal((await booked(t, svc.id, D, 555)).json.reason, 'slot_passed', '09:15 has started');
    const a = await avail(t, svc.id, D);
    assert.deepEqual(a.bookableSlots.slice(0, 3), [570, 585, 600], 'availability agrees: 09:30 is the next slot');
    assert.equal((await booked(t, svc.id, D, 570)).status, 200);
    await at(`${D}T09:30:59Z`); // still minute 570: the slot may be booked until its start minute is over
    assert.equal((await booked(t, svc.id, D, 585)).status, 200);
    assert.equal((await booked(t, svc.id, D, 570)).status, 200, 'the 09:30 slot is still in its own start minute');
    await at(`${D}T09:31:00Z`);
    assert.equal((await booked(t, svc.id, D, 570)).json.reason, 'slot_passed');
  });

  it('a lying client cannot book a past slot, or hide a future one: clockMinutes is ignored', async () => {
    await at(`${D}T10:00:00Z`);
    const lie0 = await booked(t, svc.id, D, 540, { clockMinutes: 0 });
    assert.equal(lie0.status, 409, 'client says it is midnight; the server knows it is 10:00'); assert.equal(lie0.json.reason, 'slot_passed');
    const a = await avail(t, svc.id, D, '&clockMinutes=0');
    assert.ok(a.bookableSlots.every((s) => s >= 600), `past slots offered: ${a.bookableSlots}`);
    assert.equal(a.nowMinutes, 600); assert.equal(a.timezone, 'Europe/London'); assert.equal(a.today, D);
    const lieLate = await avail(t, svc.id, D, '&clockMinutes=1439');
    assert.equal(lieLate.open, true, 'a client claiming it is 23:59 does not close the service'); assert.ok(lieLate.bookableSlots.includes(600));
    assert.equal((await booked(t, svc.id, D, 615, { clockMinutes: 1439 })).status, 200, 'a client claiming 23:59 does not make a future slot "past"');
    for (const junk of ['abc', '-5', '99999', '1e9', '[1]']) assert.equal((await get(`${P(t)}/services/${svc.id}/availability?date=${D}&clockMinutes=${junk}`)).status, 200, junk);
  });

  it('a walk-in joins the block the SERVER says is current, whatever clockMinutes the client sends', async () => {
    await at(`${D}T10:10:00Z`);
    const r = await walkIn(t, svc.id, D, { clockMinutes: 540 });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.ticket.hour_block, 600, 'not 540 as the lying client claimed');
    await at(`${D}T09:10:00Z`);
    const r2 = await walkIn(t, svc.id, D, { clockMinutes: 1000 });
    assert.equal(r2.json.ticket.hour_block, 540);
    await at(`${D}T11:00:00Z`); // last block 10:30-11:00 is over
    const closed = await walkIn(t, svc.id, D, { clockMinutes: 540 });
    assert.equal(closed.status, 409); assert.equal(closed.json.reason, 'closed');
    assert.deepEqual([(await avail(t, svc.id, D, '&clockMinutes=540')).open, (await avail(t, svc.id, D, '&clockMinutes=540')).reason], [false, 'closed']);
  });

  it('an explicit walk-in block that has finished is refused; the current and later ones are fine', async () => {
    await at(`${D}T10:10:00Z`);
    const old = await walkIn(t, svc.id, D, { hourBlock: 540 });
    assert.equal(old.status, 409, old.text); assert.equal(old.json.reason, 'block_passed');
    assert.equal((await walkIn(t, svc.id, D, { hourBlock: 570 })).json.reason, 'block_passed', '09:30-10:00 is over');
    assert.equal((await walkIn(t, svc.id, D, { hourBlock: 600 })).status, 200, 'the block we are in');
    assert.equal((await walkIn(t, svc.id, D, { hourBlock: 630 })).status, 200, 'a later block');
  });

  it('staff: call-next hands out a booking only once its slot has started on the SERVER clock', async () => {
    await at(`${D}T06:00:00Z`);
    const t2 = await signup('callnext'); const s2 = t2.services[0];
    await goLive(t2, s2, { plan: 'day', start: D, hours: [540, 570, 600, 630], staff: { staffCount: 4, bookingStaffCount: 2, walkInStaffCount: 2 } });
    const st = await addStaff(t2);
    const b = (await booked(t2, s2.id, D, 600)).json.ticket;
    await at(`${D}T09:30:00Z`);
    const early = await callNext(st.token, s2.id, D, { clockMinutes: 1439 });
    assert.equal(early.status, 404, `the 10:00 booking is not due at 09:30 even though the client claims 23:59: ${early.text}`);
    await at(`${D}T10:00:05Z`);
    const due = await callNext(st.token, s2.id, D, { clockMinutes: 0 });
    assert.equal(due.status, 200, due.text); assert.equal(due.json.ticket.id, b.id);
    assert.equal((await callNext(st.token, s2.id, D, { clockMinutes: 'abc' })).status, 400, 'syntactic nonsense is still a 400');
  });

  it('staff: return-to-queue and route use the server clock for the block; the Today ribbon says the server time', async () => {
    await at(`${D}T06:00:00Z`);
    const t3 = await signup('requeue'); const s3 = t3.services[0];
    await goLive(t3, s3, { plan: 'day', start: D, hours: [540, 570, 600, 630], staff: { staffCount: 4, bookingStaffCount: 1, walkInStaffCount: 3 } });
    const s3b = await newService(t3, t3.locations[0].id, 'Hygiene Room');
    await goLive(t3, s3b, { plan: 'day', start: D, hours: [540, 570, 600, 630] });
    const st = await addStaff(t3);
    await at(`${D}T09:40:00Z`);
    const w = (await walkIn(t3, s3.id, D)).json.ticket;
    assert.equal(w.hour_block, 570);
    await callNext(st.token, s3.id, D);
    await at(`${D}T10:05:00Z`);
    const back = await post(`/api/tenant/tickets/${w.id}/return-to-queue`, { clockMinutes: 540 }, { token: st.token });
    assert.equal(back.status, 200, back.text); assert.equal(back.json.ticket.hour_block, 600, 'server says 10:05, not 09:00');
    await callNext(st.token, s3.id, D);
    const routed = await post(`/api/tenant/tickets/${w.id}/route`, { newServiceId: s3b.id, clockMinutes: 1 }, { token: st.token });
    assert.equal(routed.status, 200, routed.text); assert.equal(routed.json.ticket.hour_block, 600);
    const rb = await ribbon(t3, s3.id);
    assert.equal(rb.nowMinutes, 605); assert.equal(rb.timezone, 'Europe/London'); assert.equal(rb.date, D);
    const rb2 = (await get(`/api/tenant/today?serviceId=${s3.id}&clockMinutes=30`, { token: t3.token })).json;
    assert.equal(rb2.nowMinutes, 605, 'a client clockMinutes does not move the ribbon');
  });

  it('admin: hours that have already started cannot be changed, whatever nowMinutes the client sends', async () => {
    await at(`${D}T06:00:00Z`);
    const t4 = await signup('hours'); const s4 = t4.services[0];
    await goLive(t4, s4, { plan: 'day', start: D, hours: [540, 570, 600, 630] });
    await at(`${D}T10:00:00Z`);
    const lie = await putDay(t4, s4.id, D, { hours: [570, 600, 630], nowMinutes: 0 });
    assert.equal(lie.status, 409, `removing the started 09:00 block must fail even though the client says it is midnight: ${lie.text}`);
    assert.equal((await putDay(t4, s4.id, D, { hours: [540, 570, 600, 630, 660], nowMinutes: 1439 })).status, 200, 'adding a future block is fine even if the client claims 23:59');
    assert.equal((await putDay(t4, s4.id, D, { hours: [510, 540, 570, 600, 630, 660], nowMinutes: 1439 })).status, 409, 'adding a block in the past is refused');
  });
});

// =====================================================================================
// B. DST: skipped and repeated wall-clock hours
// =====================================================================================
describe('B. DST: no phantom or duplicated slots, minutes-of-day correct on 23h and 25h days', () => {
  describe('the day-shape of a zone (unit)', () => {
    let clk;
    before(async () => { process.env.NODE_ENV = 'test'; clk = await import('../src/lib/clock.js'); });
    after(() => { clk.clearTestNow(); delete process.env.NODE_ENV; });
    const cases = [
      ['Europe/London', '2026-03-29', { gaps: [[60, 120]], folds: [], minutes: 1380 }],
      ['Europe/London', '2026-10-25', { gaps: [], folds: [[60, 120]], minutes: 1500 }],
      ['Europe/London', '2026-07-01', { gaps: [], folds: [], minutes: 1440 }],
      ['America/New_York', '2026-03-08', { gaps: [[120, 180]], folds: [], minutes: 1380 }],
      ['America/New_York', '2026-11-01', { gaps: [], folds: [[60, 120]], minutes: 1500 }],
      ['Australia/Lord_Howe', '2026-10-04', { gaps: [[120, 150]], folds: [], minutes: 1410 }],
      ['Australia/Lord_Howe', '2026-04-05', { gaps: [], folds: [[90, 120]], minutes: 1470 }],
      ['Pacific/Auckland', '2026-09-27', { gaps: [[120, 180]], folds: [], minutes: 1380 }],
      ['Pacific/Auckland', '2026-04-05', { gaps: [], folds: [[120, 180]], minutes: 1500 }],
      ['Asia/Kolkata', '2026-03-29', { gaps: [], folds: [], minutes: 1440 }],
      ['Asia/Kolkata', '2026-10-25', { gaps: [], folds: [], minutes: 1440 }],
      ['UTC', '2026-03-29', { gaps: [], folds: [], minutes: 1440 }],
      ['Pacific/Chatham', '2026-09-27', { gaps: [[165, 225]], folds: [], minutes: 1380 }], // 45-minute-offset zone: 02:45 -> 03:45
    ];
    for (const [tz, date, want] of cases) {
      it(`${tz} ${date}: ${want.gaps.length ? `skips ${want.gaps.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`)}` : want.folds.length ? `repeats ${want.folds.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`)}` : 'is a normal 24-hour day'}`, () => {
        assert.deepEqual(clk.dayShape(tz, date), want);
      });
    }
    it('minuteExists / minuteIsRepeated agree with the shape', () => {
      assert.equal(clk.minuteExists('Europe/London', '2026-03-29', 90), false);
      assert.equal(clk.minuteExists('Europe/London', '2026-03-29', 120), true);
      assert.equal(clk.minuteExists('Europe/London', '2026-03-29', 59), true);
      assert.equal(clk.minuteIsRepeated('Europe/London', '2026-10-25', 90), true);
      assert.equal(clk.minuteIsRepeated('Europe/London', '2026-10-25', 120), false);
    });
    // [zone, UTC instant, expected local date, expected local minutes]
    const instants = [
      ['Europe/London', '2026-07-01T23:30:00Z', '2026-07-02', 30],
      ['America/New_York', '2026-07-02T03:59:00Z', '2026-07-01', 1439],
      ['America/New_York', '2026-07-02T04:00:00Z', '2026-07-02', 0],
      ['America/New_York', '2026-03-08T06:59:00Z', '2026-03-08', 119],
      ['America/New_York', '2026-03-08T07:00:00Z', '2026-03-08', 180],
      ['Asia/Kolkata', '2026-07-01T18:29:00Z', '2026-07-01', 1439],
      ['Asia/Kolkata', '2026-07-01T18:30:00Z', '2026-07-02', 0],
      ['Asia/Kolkata', '2026-07-02T03:50:00Z', '2026-07-02', 560],
      ['Australia/Lord_Howe', '2026-10-03T15:29:00Z', '2026-10-04', 119],
      ['Australia/Lord_Howe', '2026-10-03T15:30:00Z', '2026-10-04', 150],
      ['Australia/Lord_Howe', '2026-07-02T03:50:00Z', '2026-07-02', 860],
      ['Pacific/Auckland', '2026-07-01T12:00:00Z', '2026-07-02', 0],
      ['Pacific/Auckland', '2026-04-04T13:59:00Z', '2026-04-05', 179],
      ['Pacific/Auckland', '2026-04-04T14:00:00Z', '2026-04-05', 120],
    ];
    for (const [tz, iso, date, mins] of instants) {
      it(`${iso} in ${tz} is ${date} ${hhmm(mins)}`, () => {
        assert.equal(clk.localDate(new Date(iso), tz), date);
        assert.equal(clk.localMinutes(new Date(iso), tz), mins);
      });
    }
    it('getToday(tz) honours the System Admin simulated date for every zone, but not the time of day', () => {
      clk.setTestNow('2026-07-02T03:50:00Z', { frozen: true });
      clk.setSimulatedToday('2026-12-01');
      try {
        assert.equal(clk.getToday('Asia/Kolkata'), '2026-12-01'); assert.equal(clk.getToday('America/New_York'), '2026-12-01');
        assert.equal(clk.nowMinutes('Asia/Kolkata'), 560); assert.equal(clk.nowMinutes('America/New_York'), 1430);
      } finally { clk.clearSimulatedToday(); }
      assert.equal(clk.getToday('America/New_York'), '2026-07-01');
    });
  });

  describe('London, clocks go forward (29 Mar 2026: 01:00-02:00 does not exist)', () => {
    let t, svc;
    before(async () => {
      await at('2026-03-28T10:00:00Z');
      t = await signup('spring'); svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-03-29', hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 5, walkInStaffCount: 5 } });
    });
    it('the stored all-day hours include the skipped hour, but nothing in it is offered', async () => {
      await at('2026-03-29T00:00:30Z'); // 00:00:30 GMT, 15-minute slots
      const a = await avail(t, svc.id, '2026-03-29');
      assert.equal(a.open, true);
      const phantom = a.bookableSlots.filter((s) => s >= 60 && s < 120);
      assert.deepEqual(phantom, [], `phantom slots offered in the skipped hour: ${phantom}`);
      assert.ok(a.bookableSlots.includes(45) && a.bookableSlots.includes(120), 'the slots either side of the gap exist');
      assert.equal(new Set(a.bookableSlots).size, a.bookableSlots.length, 'no duplicates');
      assert.deepEqual([...a.bookableSlots].sort((x, y) => x - y), a.bookableSlots, 'in order');
    });
    it('booking a phantom slot, or a walk-in into a phantom block, is refused', async () => {
      for (const slot of [60, 75, 90, 105]) {
        const r = await booked(t, svc.id, '2026-03-29', slot);
        assert.equal(r.status, 409, `slot ${hhmm(slot)}: ${r.text}`); assert.equal(r.json.reason, 'slot_unavailable');
      }
      for (const block of [60, 90]) assert.equal((await walkIn(t, svc.id, '2026-03-29', { hourBlock: block })).status, 400, `block ${hhmm(block)}`);
      assert.equal((await booked(t, svc.id, '2026-03-29', 45)).status, 200); assert.equal((await booked(t, svc.id, '2026-03-29', 120)).status, 200);
    });
    it('the Today ribbon has no blocks inside the gap and says the day is 23 hours long', async () => {
      await at('2026-03-29T00:30:00Z');
      const rb = await ribbon(t, svc.id);
      assert.equal(rb.open, true); assert.equal(rb.date, '2026-03-29'); assert.equal(rb.nowMinutes, 30); assert.equal(rb.dayMinutes, 1380);
      const starts = rb.blocks.map((b) => b.start);
      assert.deepEqual(starts.filter((s) => s >= 60 && s < 120), []);
      assert.equal(new Set(starts).size, starts.length); assert.equal(starts.length, 46, '48 half-hour blocks less the two that do not exist');
    });
    it('a walk-in just before the change lands in the 00:30 block; just after, in the 02:00 block (the wall clock jumped)', async () => {
      await at('2026-03-29T00:59:00Z');
      assert.equal((await walkIn(t, svc.id, '2026-03-29')).json.ticket.hour_block, 30);
      await at('2026-03-29T01:00:30Z');
      assert.equal((await walkIn(t, svc.id, '2026-03-29')).json.ticket.hour_block, 120);
      assert.equal((await avail(t, svc.id, '2026-03-29')).nowMinutes, 120);
    });
    it('the editor is told about the odd day (daily-config reports the shape); ordinary days are not listed', async () => {
      const r = (await get(`/api/tenant/services/${svc.id}/daily-config?from=2026-03-28&to=2026-03-30`, { token: t.token })).json;
      assert.equal(r.timezone, 'Europe/London');
      assert.deepEqual(Object.keys(r.dayShapes), ['2026-03-29']); assert.deepEqual(r.dayShapes['2026-03-29'].gaps, [[60, 120]]); assert.equal(r.dayShapes['2026-03-29'].minutes, 1380);
    });
    it('the whole 23-hour day is bookable up to 23:45, and the day after is a normal 24 hours', async () => {
      await at('2026-03-29T00:00:30Z');
      const a = await avail(t, svc.id, '2026-03-29');
      assert.equal(a.bookableSlots.at(-1), 1425);
      assert.equal(a.bookableSlots.length, 92, '23 real hours x 4 slots; the nonexistent 01:00-02:00 has none'); // 24 hour-blocks minus the skipped one
    });
  });

  describe('London, clocks go back (25 Oct 2026: 01:00-02:00 happens twice)', () => {
    let t, svc;
    before(async () => {
      await at('2026-10-24T10:00:00Z');
      t = await signup('autumn'); svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-10-25', hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 1, walkInStaffCount: 9 } });
    });
    it('the repeated hour is offered once: no duplicated slots in availability or the ribbon, and the day is 25 hours', async () => {
      await at('2026-10-24T23:10:00Z'); // 00:10 BST on the 25th
      const a = await avail(t, svc.id, '2026-10-25');
      assert.equal(new Set(a.bookableSlots).size, a.bookableSlots.length, 'no duplicate slot');
      assert.deepEqual(a.bookableSlots.filter((s) => s >= 60 && s < 120), [60, 75, 90, 105], 'the 01:00-02:00 slots exist exactly once');
      const rb = await ribbon(t, svc.id);
      assert.equal(rb.dayMinutes, 1500); assert.equal(new Set(rb.blocks.map((b) => b.start)).size, rb.blocks.length); assert.equal(rb.blocks.length, 48);
    });
    it('first pass (01:10 BST = 00:10Z): the 01:30 slot is ahead and can be booked; capacity is per wall-clock slot, so it is full for both passes', async () => {
      await at('2026-10-25T00:10:00Z');
      const r = await booked(t, svc.id, '2026-10-25', 90);
      assert.equal(r.status, 200, r.text);
      const again = await booked(t, svc.id, '2026-10-25', 90);
      assert.equal(again.status, 409); assert.equal(again.json.reason, 'slot_full', 'one booking staff: the 01:30 slot is taken once, not once per pass');
      assert.ok(!(await avail(t, svc.id, '2026-10-25')).bookableSlots.includes(90));
    });
    it('second pass (01:20 GMT = 01:20Z): wall-clock minutes behave consistently - 01:15 has gone, 01:45 is ahead', async () => {
      await at('2026-10-25T01:20:00Z');
      const a = await avail(t, svc.id, '2026-10-25');
      assert.equal(a.nowMinutes, 80);
      assert.ok(a.bookableSlots.every((s) => s >= 80), `a slot earlier than 01:20 is offered: ${a.bookableSlots.slice(0, 6)}`);
      assert.equal((await booked(t, svc.id, '2026-10-25', 75)).json.reason, 'slot_passed');
      assert.equal((await booked(t, svc.id, '2026-10-25', 105)).status, 200);
    });
    it('walk-ins in either pass land in the same wall-clock block, and the day number does not roll at "24 hours"', async () => {
      await at('2026-10-25T00:40:00Z'); const a = await walkIn(t, svc.id, '2026-10-25');
      await at('2026-10-25T01:40:00Z'); const b = await walkIn(t, svc.id, '2026-10-25');
      assert.equal(a.json.ticket.hour_block, 90); assert.equal(b.json.ticket.hour_block, 90);
      await at('2026-10-25T23:30:00Z'); assert.equal((await avail(t, svc.id, '2026-10-25')).today, '2026-10-25', '23:30 GMT is still the 25th (25-hour day)');
      assert.equal((await avail(t, svc.id, '2026-10-25')).nowMinutes, 1410);
    });
  });

  describe('New York, Lord Howe (30-minute shift) and Auckland', () => {
    it('New York spring forward 8 Mar 2026 (02:00-03:00 skipped)', async () => {
      await at('2026-03-07T15:00:00Z');
      const t = await signup('ny-dst'); const loc = await newLocation(t, 'NYC', 'America/New_York'); const svc = await newService(t, loc.id, 'Walk In');
      await goLive(t, svc, { plan: 'day', start: '2026-03-08', hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 5, walkInStaffCount: 5 } });
      await at('2026-03-08T06:30:00Z'); // 01:30 EST
      let a = await avail(t, svc.id, '2026-03-08');
      assert.equal(a.timezone, 'America/New_York'); assert.equal(a.nowMinutes, 90); assert.equal(a.today, '2026-03-08');
      assert.deepEqual(a.bookableSlots.slice(0, 4), [90, 105, 180, 195], 'after 01:45 comes 03:00 - nothing in between');
      assert.equal((await booked(t, svc.id, '2026-03-08', 150)).json.reason, 'slot_unavailable');
      await at('2026-03-08T07:00:30Z'); // 03:00:30 EDT
      a = await avail(t, svc.id, '2026-03-08'); assert.equal(a.nowMinutes, 180); assert.equal(a.walkIn.block, 180);
      assert.equal((await ribbon(t, svc.id)).dayMinutes, 1380);
    });
    it('New York fall back 1 Nov 2026 (01:00-02:00 twice)', async () => {
      await at('2026-10-31T15:00:00Z');
      const t = await signup('ny-fall'); const loc = await newLocation(t, 'NYC', 'America/New_York'); const svc = await newService(t, loc.id, 'Walk In');
      await goLive(t, svc, { plan: 'day', start: '2026-11-01', hours: ALLDAY });
      await at('2026-11-01T05:30:00Z'); // 01:30 EDT (first pass)
      const a = await avail(t, svc.id, '2026-11-01');
      assert.equal(a.nowMinutes, 90); assert.deepEqual(a.bookableSlots.filter((s) => s >= 60 && s < 120), [90, 105]);
      await at('2026-11-01T06:30:00Z'); // 01:30 EST (second pass)
      assert.equal((await avail(t, svc.id, '2026-11-01')).nowMinutes, 90);
      assert.equal((await ribbon(t, svc.id)).dayMinutes, 1500);
    });
    it('Lord Howe 4 Oct 2026: the clocks jump 30 minutes (02:00 -> 02:30), so 02:00-02:30 does not exist', async () => {
      await at('2026-10-01T10:00:00Z');
      const t = await signup('lh'); const loc = await newLocation(t, 'Lord Howe Island', 'Australia/Lord_Howe'); const svc = await newService(t, loc.id, 'Walk In');
      await goLive(t, svc, { plan: 'day', start: '2026-10-04', hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 5, walkInStaffCount: 5 } });
      await at('2026-10-03T15:00:00Z'); // 01:30 LHST (+10:30) on the 4th
      let a = await avail(t, svc.id, '2026-10-04');
      assert.equal(a.today, '2026-10-04'); assert.equal(a.nowMinutes, 90);
      assert.deepEqual(a.bookableSlots.slice(0, 5), [90, 105, 150, 165, 180], '01:45 is followed by 02:30');
      assert.equal((await booked(t, svc.id, '2026-10-04', 120)).json.reason, 'slot_unavailable'); assert.equal((await booked(t, svc.id, '2026-10-04', 135)).json.reason, 'slot_unavailable');
      assert.equal((await walkIn(t, svc.id, '2026-10-04', { hourBlock: 120 })).status, 400, 'the 02:00 block does not exist');
      assert.equal((await walkIn(t, svc.id, '2026-10-04', { hourBlock: 150 })).status, 200, 'the 02:30 block does');
      await at('2026-10-03T15:45:00Z'); // 02:45 LHDT
      a = await avail(t, svc.id, '2026-10-04'); assert.equal(a.nowMinutes, 165);
      assert.ok(a.bookableSlots.every((s) => s >= 165));
      assert.equal((await ribbon(t, svc.id)).dayMinutes, 1410);
    });
    it('Auckland 5 Apr 2026: 02:00-03:00 happens twice (NZDT -> NZST)', async () => {
      await at('2026-04-03T10:00:00Z');
      const t = await signup('akl'); const loc = await newLocation(t, 'Auckland', 'Pacific/Auckland'); const svc = await newService(t, loc.id, 'Walk In');
      await goLive(t, svc, { plan: 'day', start: '2026-04-05', hours: ALLDAY });
      await at('2026-04-04T13:30:00Z'); // 02:30 NZDT, first pass
      let a = await avail(t, svc.id, '2026-04-05');
      assert.equal(a.nowMinutes, 150); assert.equal(new Set(a.bookableSlots).size, a.bookableSlots.length);
      assert.deepEqual(a.bookableSlots.filter((s) => s >= 120 && s < 180), [150, 165]);
      await at('2026-04-04T14:30:00Z'); // 02:30 NZST, second pass
      a = await avail(t, svc.id, '2026-04-05'); assert.equal(a.nowMinutes, 150); assert.equal(a.today, '2026-04-05');
      assert.equal((await ribbon(t, svc.id)).dayMinutes, 1500);
    });
  });
});

// =====================================================================================
// C. PER-LOCATION TIME ZONES
// =====================================================================================
describe('C. every location runs on its own clock', () => {
  const ZONES = { london: 'Europe/London', ny: 'America/New_York', kol: 'Asia/Kolkata', lh: 'Australia/Lord_Howe', akl: 'Pacific/Auckland' };
  let t, svc, st;
  before(async () => {
    await at('2026-06-29T10:00:00Z');
    t = await signup('zones', { locations: [{ name: 'London' }], services: [{ name: 'Walk In', locationIndex: 0 }] });
    const locs = { london: t.locations[0] };
    svc = { london: t.services[0] };
    for (const k of ['ny', 'kol', 'lh', 'akl']) {
      locs[k] = await newLocation(t, `Site ${k}`, ZONES[k]);
      svc[k] = await newService(t, locs[k].id, 'Walk In');
    }
    // A week from the 30th at every site; hours 09:00-10:00 on the 1st-3rd of July.
    for (const k of Object.keys(ZONES)) {
      const lic = await buyLicence(t, svc[k].id, 'week');
      assert.equal((await patch(`/api/tenant/services/${svc[k].id}/licenses/${lic.id}`, { startDate: '2026-06-30' }, { token: t.token })).status, 200, k);
      for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) assert.equal((await putDay(t, svc[k].id, d, { hours: [540, 570] })).status, 200);
    }
    st = await addStaff(t);
  });

  it('each location reports its time zone (locations list, public chooser, services list, public time)', async () => {
    const mine = (await get('/api/tenant/locations', { token: t.token })).json.locations;
    assert.deepEqual(Object.fromEntries(mine.map((l) => [l.name, l.timezone])), { London: 'Europe/London', 'Site ny': 'America/New_York', 'Site kol': 'Asia/Kolkata', 'Site lh': 'Australia/Lord_Howe', 'Site akl': 'Pacific/Auckland' });
    const pub = (await get(`${P(t)}/locations`)).json.locations;
    assert.equal(pub.find((l) => l.name === 'Site kol').timezone, 'Asia/Kolkata');
    const svcs = (await get(`${P(t)}/services`)).json.services;
    assert.equal(svcs.find((s) => s.id === svc.ny.id).timezone, 'America/New_York');
    await at('2026-07-02T03:50:00Z');
    const tm = (await get('/api/public/time?tz=Asia/Kolkata')).json;
    assert.deepEqual([tm.timezone, tm.today, tm.minutes, tm.now], ['Asia/Kolkata', '2026-07-02', 560, '2026-07-02T03:50:00.000Z']);
    assert.equal((await get('/api/public/time?tz=America/New_York')).json.today, '2026-07-01');
    assert.equal((await get('/api/public/time')).json.today, '2026-07-02', 'no tz = the platform default (Europe/London)');
    assert.equal((await get('/api/public/time?tz=Mars/Olympus')).status, 400);
    assert.equal((await get('/api/public/time?tz=%2B05:00')).status, 400);
  });

  it('03:50Z on 2 July: before opening in London, still yesterday in New York, mid-block in Kolkata, after hours in Lord Howe and Auckland', async () => {
    await at('2026-07-02T03:50:00Z');
    const a = Object.fromEntries(await Promise.all(Object.keys(ZONES).map(async (k) => [k, await avail(t, svc[k].id, k === 'ny' ? '2026-07-01' : '2026-07-02')])));
    // London 04:50 BST: the service has not opened yet but the first block can be joined
    assert.deepEqual([a.london.open, a.london.walkIn.block, a.london.nowMinutes, a.london.today], [true, 540, 290, '2026-07-02']);
    // New York 23:50 EDT on the 1st: its day is over (last block ended 10:00)
    assert.deepEqual([a.ny.open, a.ny.reason, a.ny.nowMinutes, a.ny.today], [false, 'closed', 1430, '2026-07-01']);
    // Kolkata 09:20 IST: inside the 09:00 block
    assert.deepEqual([a.kol.open, a.kol.walkIn.block, a.kol.nowMinutes], [true, 540, 560]);
    assert.deepEqual(a.kol.bookableSlots.slice(0, 2), [570, 585], 'only slots from 09:20 on (09:30, 09:45)');
    // Lord Howe 14:20 and Auckland 15:50: closed
    assert.deepEqual([a.lh.open, a.lh.reason, a.lh.nowMinutes, a.lh.timezone], [false, 'closed', 860, 'Australia/Lord_Howe']);
    assert.deepEqual([a.akl.open, a.akl.reason, a.akl.nowMinutes], [false, 'closed', 950]);
  });

  it('joining uses each location\'s own "today": the UTC date and other zones\' dates are refused', async () => {
    await at('2026-07-02T03:50:00Z');
    // Kolkata: today is the 2nd. The block now is 09:00; the 1st has passed.
    const k = await walkIn(t, svc.kol.id, '2026-07-02'); assert.equal(k.status, 200, k.text); assert.equal(k.json.ticket.hour_block, 540); assert.equal(k.json.ticket.visit_date, '2026-07-02');
    assert.equal((await walkIn(t, svc.kol.id, '2026-07-01', { hourBlock: 540 })).json.reason, 'closed', 'that day has passed in Kolkata');
    // New York: today is still the 1st and it is after hours; the 2nd can be joined only with an explicit block (another day)
    assert.equal((await walkIn(t, svc.ny.id, '2026-07-01')).json.reason, 'closed');
    assert.equal((await walkIn(t, svc.ny.id, '2026-07-02')).status, 400, 'tomorrow needs an hourBlock');
    assert.equal((await walkIn(t, svc.ny.id, '2026-07-02', { hourBlock: 540 })).status, 200);
    // London: the 2nd, before opening
    assert.equal((await walkIn(t, svc.london.id, '2026-07-02')).json.ticket.hour_block, 540);
    // Slots: Kolkata 09:15 is past, 09:30 fine; London 09:00 is ahead
    assert.equal((await booked(t, svc.kol.id, '2026-07-02', 555)).json.reason, 'slot_passed');
    assert.equal((await booked(t, svc.kol.id, '2026-07-02', 570)).status, 200);
    assert.equal((await booked(t, svc.london.id, '2026-07-02', 540)).status, 200);
    // Lord Howe 14:20 / Auckland 15:50: past closing, and a booking for a 09:00 slot today is in the past
    assert.equal((await booked(t, svc.lh.id, '2026-07-02', 540)).json.reason, 'slot_passed');
    assert.equal((await booked(t, svc.akl.id, '2026-07-02', 540)).json.reason, 'slot_passed');
    assert.equal((await walkIn(t, svc.akl.id, '2026-07-02')).json.reason, 'closed');
  });

  it('a client-supplied clockMinutes from the patient\'s own time zone is ignored: the LOCATION\'s clock rules', async () => {
    await at('2026-07-02T03:50:00Z');
    // A patient in London looking at the Kolkata clinic sends London minutes (290): still 09:20 at the clinic.
    const a = await avail(t, svc.kol.id, '2026-07-02', '&clockMinutes=290');
    assert.deepEqual([a.nowMinutes, a.walkIn.block], [560, 540]);
    const r = await walkIn(t, svc.kol.id, '2026-07-02', { clockMinutes: 290 });
    assert.equal(r.json.ticket.hour_block, 540);
  });

  it('the Today ribbon is per location', async () => {
    await at('2026-07-02T03:50:00Z');
    const r = await ribbon(t, svc.kol.id);
    assert.deepEqual([r.date, r.timezone, r.nowMinutes, r.open], ['2026-07-02', 'Asia/Kolkata', 560, true]);
    const n = await ribbon(t, svc.ny.id);
    assert.deepEqual([n.date, n.timezone, n.nowMinutes], ['2026-07-01', 'America/New_York', 1430]);
  });

  it('midnight: New York turns over at 04:00Z, London at 23:00Z, Kolkata at 18:30Z, Auckland at 12:00Z, Lord Howe at 13:30Z', async () => {
    const today = async (k) => (await avail(t, svc[k].id, '2026-07-02')).today;
    const expect = (instant, want) => async () => { await at(instant); for (const [k, d] of Object.entries(want)) assert.equal(await today(k), d, `${k} at ${instant}`); };
    await expect('2026-07-01T11:59:30Z', { akl: '2026-07-01', lh: '2026-07-01', kol: '2026-07-01', london: '2026-07-01', ny: '2026-07-01' })();
    await expect('2026-07-01T12:00:30Z', { akl: '2026-07-02', lh: '2026-07-01', kol: '2026-07-01', london: '2026-07-01', ny: '2026-07-01' })();
    await expect('2026-07-01T13:30:30Z', { akl: '2026-07-02', lh: '2026-07-02', kol: '2026-07-01', london: '2026-07-01', ny: '2026-07-01' })();
    await expect('2026-07-01T18:30:30Z', { akl: '2026-07-02', lh: '2026-07-02', kol: '2026-07-02', london: '2026-07-01', ny: '2026-07-01' })();
    await expect('2026-07-01T23:00:30Z', { akl: '2026-07-02', lh: '2026-07-02', kol: '2026-07-02', london: '2026-07-02', ny: '2026-07-01' })();
    await expect('2026-07-02T04:00:30Z', { akl: '2026-07-02', lh: '2026-07-02', kol: '2026-07-02', london: '2026-07-02', ny: '2026-07-02' })();
  });

  it('licences run on the location\'s calendar: a one-day licence for 1 July ends at New York midnight (04:00Z), five hours after London\'s', async () => {
    await at('2026-06-30T10:00:00Z');
    const t2 = await signup('lic-zones', { locations: [{ name: 'London' }], services: [{ name: 'Walk In', locationIndex: 0 }] });
    const nyLoc = await newLocation(t2, 'NYC', 'America/New_York'); const nySvc = await newService(t2, nyLoc.id, 'Walk In');
    const lonSvc = t2.services[0];
    const lonLic = await goLive(t2, lonSvc, { plan: 'day', start: '2026-07-01', hours: ALLDAY });
    const nyLic = await goLive(t2, nySvc, { plan: 'day', start: '2026-07-01', hours: ALLDAY });
    await at('2026-07-01T22:59:30Z'); // 23:59 BST / 18:59 EDT
    assert.deepEqual([(await licStatus(t2, lonSvc.id, lonLic.id)), (await licStatus(t2, nySvc.id, nyLic.id))], ['active', 'active']);
    await at('2026-07-01T23:00:30Z'); // London's day is over
    assert.deepEqual([(await licStatus(t2, lonSvc.id, lonLic.id)), (await licStatus(t2, nySvc.id, nyLic.id))], ['expired', 'active']);
    assert.equal((await avail(t2, lonSvc.id, '2026-07-01')).open, false);
    assert.equal((await avail(t2, nySvc.id, '2026-07-01')).open, true, 'it is still 19:00 on the 1st in New York');
    await at('2026-07-02T03:59:30Z'); assert.equal((await licStatus(t2, nySvc.id, nyLic.id)), 'active');
    await at('2026-07-02T04:00:30Z'); assert.equal((await licStatus(t2, nySvc.id, nyLic.id)), 'expired');
    assert.equal((await avail(t2, nySvc.id, '2026-07-01')).open, false);
  });

  it('end-of-day sweep: an unclosed called ticket is closed when ITS location\'s day ends, stamped with that zone\'s last second', async () => {
    await at('2026-07-01T12:00:00Z');
    const t3 = await signup('sweep', { locations: [{ name: 'London' }], services: [{ name: 'Walk In', locationIndex: 0 }] });
    const nyLoc = await newLocation(t3, 'NYC', 'America/New_York'); const nySvc = await newService(t3, nyLoc.id, 'Walk In');
    const lonSvc = t3.services[0];
    await goLive(t3, lonSvc, { plan: 'week', start: '2026-07-01', hours: ALLDAY });
    await goLive(t3, nySvc, { plan: 'week', start: '2026-07-01', hours: ALLDAY });
    const s = await addStaff(t3);
    const a = (await walkIn(t3, lonSvc.id, '2026-07-01')).json.ticket; const b = (await walkIn(t3, nySvc.id, '2026-07-01')).json.ticket;
    await callNext(s.token, lonSvc.id, '2026-07-01'); await callNext(s.token, nySvc.id, '2026-07-01');
    const status = (id) => sqlJson(`select status, closed_by_system, finished_at from tickets where id='${id}'`)[0];
    await at('2026-07-02T03:30:00Z'); // 04:30 BST on the 2nd (London's 1st is over), 23:30 EDT on the 1st
    const list = (await get('/api/tenant/tickets', { token: s.token })).json.tickets; // listing runs the sweep
    assert.equal(status(a.id).status, 'completed'); assert.equal(status(a.id).closed_by_system, true);
    assert.equal(new Date(status(a.id).finished_at).toISOString(), '2026-07-01T22:59:59.000Z', 'London midnight (BST) less a second');
    assert.equal(status(b.id).status, 'serving', 'still New York\'s 1st');
    // With no ?date= the list is "today" at each ticket's own location: New York's ticket (the 1st, still today there) is in it, London's (swept, the 1st, not today) is not.
    assert.deepEqual(list.map((x) => x.id), [b.id]);
    assert.deepEqual((await get('/api/tenant/tickets?date=2026-07-01', { token: s.token })).json.tickets.map((x) => x.id).sort(), [a.id, b.id].sort(), 'an explicit date is exact everywhere');
    const stats = (await get('/api/tenant/dashboard/stats', { token: s.token })).json.stats;
    assert.deepEqual([stats.serving, stats.completed], [1, 0], 'dashboard "today" is per location too');
    await at('2026-07-02T04:00:30Z');
    await get('/api/tenant/tickets', { token: s.token });
    assert.equal(status(b.id).status, 'completed');
    assert.equal(new Date(status(b.id).finished_at).toISOString(), '2026-07-02T03:59:59.000Z', 'New York midnight (EDT) less a second');
  });

  it('the System Admin simulated date replaces the date in every zone but never the time of day', async () => {
    await at('2026-07-02T03:50:00Z');
    const tok = await systemToken();
    await post('/api/system/clock', { date: '2026-07-03' }, { token: tok });
    try {
      assert.deepEqual([(await get('/api/public/time?tz=America/New_York')).json.today, (await get('/api/public/time?tz=Asia/Kolkata')).json.today], ['2026-07-03', '2026-07-03']);
      const a = await avail(t, svc.kol.id, '2026-07-03');
      assert.deepEqual([a.today, a.nowMinutes, a.open], ['2026-07-03', 560, true]);
    } finally { await del('/api/system/clock', { token: tok }); }
  });
});

// =====================================================================================
// D. VALIDATION, DEFAULTS, CURRENCY
// =====================================================================================
describe('D. time zone / currency validation and defaults', () => {
  let t;
  before(async () => { await at('2026-11-10T12:00:00Z'); t = await signup('tzval'); });

  it('a new location starts in the account default (Europe/London unless changed), and the default can be changed', async () => {
    assert.equal(t.locations[0].timezone, 'Europe/London');
    assert.equal((await newLocation(t, 'Default zone')).timezone, 'Europe/London');
    const me = await patch('/api/tenant/me', { defaultTimezone: 'America/Chicago' }, { token: t.token });
    assert.equal(me.status, 200, me.text); assert.equal(me.json.tenant.default_timezone, 'America/Chicago');
    assert.equal((await get('/api/tenant/me', { token: t.token })).json.tenant.default_timezone, 'America/Chicago');
    assert.equal((await newLocation(t, 'Chicago site')).timezone, 'America/Chicago');
    assert.equal((await newLocation(t, 'Explicit wins', 'Asia/Tokyo')).timezone, 'Asia/Tokyo');
    assert.equal((await get(`${P(t)}/info`)).json.defaultTimezone, 'America/Chicago');
    await patch('/api/tenant/me', { defaultTimezone: 'Europe/London' }, { token: t.token });
  });
  it('names are validated and canonicalised: real region/city names only', async () => {
    const loc = await newLocation(t, 'Zone edits');
    const ok = async (tz, want) => { const r = await patch(`/api/tenant/locations/${loc.id}`, { timezone: tz }, { token: t.token }); assert.equal(r.status, 200, `${tz}: ${r.text}`); assert.equal(r.json.location.timezone, want ?? tz); };
    await ok('Asia/Kolkata'); await ok('asia/kolkata', 'Asia/Kolkata'); await ok('  America/Argentina/Buenos_Aires  ', 'America/Argentina/Buenos_Aires'); await ok('UTC'); await ok('Australia/Lord_Howe'); await ok('Europe/London');
    for (const bad of ['EST5EDT', '+05:00', 'Etc/GMT+5', 'Foo/Bar', 'Europe', '', 'Mars/Olympus_Mons', 'x'.repeat(70), "Europe/London'; drop table locations;--", 5, ['Europe/London'], {}]) {
      const r = await patch(`/api/tenant/locations/${loc.id}`, { timezone: bad }, { token: t.token });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${r.text}`);
    }
    assert.equal((await post('/api/tenant/locations', { name: 'Bad zone', timezone: 'Nowhere/Land' }, { token: t.token })).status, 400);
    assert.equal((await patch('/api/tenant/me', { defaultTimezone: 'Nowhere/Land' }, { token: t.token })).status, 400);
    assert.equal((await get(`/api/tenant/locations`, { token: t.token })).json.locations.find((l) => l.id === loc.id).timezone, 'Europe/London', 'a rejected change leaves the zone alone');
  });
  it('a zone cannot be changed while somebody is waiting or being served there; it can once the queue is empty; the change is logged', async () => {
    await at('2026-11-10T12:00:00Z');
    const loc = await newLocation(t, 'Busy site'); const svc = await newService(t, loc.id, 'Walk In');
    await goLive(t, svc, { plan: 'day', start: '2026-11-10', hours: ALLDAY });
    const w = (await walkIn(t, svc.id, '2026-11-10')).json.ticket;
    const r = await patch(`/api/tenant/locations/${loc.id}`, { timezone: 'Asia/Tokyo' }, { token: t.token });
    assert.equal(r.status, 409, r.text);
    assert.equal((await patch(`/api/tenant/locations/${loc.id}`, { timezone: 'Europe/London', name: 'Busy site 2' }, { token: t.token })).status, 200, 'same zone is not a change');
    await post(`/api/tenant/tickets/${w.id}/cancel`, {}, { token: t.token });
    assert.equal((await patch(`/api/tenant/locations/${loc.id}`, { timezone: 'Asia/Tokyo' }, { token: t.token })).status, 200);
    const log = (await get('/api/tenant/audit-log', { token: t.token })).json.auditLog;
    assert.ok(log.some((e) => /time zone changed from Europe\/London to Asia\/Tokyo/.test(e.message)));
  });
  it('only the account admin can set a zone (staff cannot)', async () => {
    const s = await addStaff(t);
    assert.equal((await patch(`/api/tenant/locations/${t.locations[0].id}`, { timezone: 'Asia/Tokyo' }, { token: s.token })).status, 403);
    assert.equal((await patch('/api/tenant/me', { defaultTimezone: 'Asia/Tokyo' }, { token: s.token })).status, 403);
  });
  it('the database refuses a bad zone written any other way (so the sweep can never be broken), and defaults to Europe/London', () => {
    const tid = t.id;
    assert.throws(() => sql(`insert into locations (tenant_id, name, timezone) values ('${tid}', 'psql bad', 'Mars/Base')`), /unknown time zone/);
    assert.throws(() => sql(`update locations set timezone='Nowhere/Land' where tenant_id='${tid}'`), /unknown time zone/);
    assert.throws(() => sql(`update tenants set default_timezone='Nowhere/Land' where id='${tid}'`), /unknown time zone/);
    assert.throws(() => sql(`update locations set timezone='bad zone!' where tenant_id='${tid}'`), /unknown time zone|locations_timezone_shape/);
    const id = sql(`insert into locations (tenant_id, name) values ('${tid}', 'psql default') returning id`);
    assert.equal(sql(`select timezone from locations where id='${id}'`), 'Europe/London');
    assert.equal(sql(`select currency from tenants where id='${tid}'`), 'GBP');
    assert.match(sql(`select column_default from information_schema.columns where table_name='tickets' and column_name='visit_date'`), /Europe\/London/, 'the 0017 default stays as a safety net');
  });
  it('currency: tenants default to GBP; the platform admin can set an ISO 4217 code; junk is refused', async () => {
    assert.equal((await get('/api/tenant/me', { token: t.token })).json.tenant.currency, 'GBP');
    assert.equal((await get(`${P(t)}/info`)).json.currency, 'GBP');
    const tok = await systemToken();
    const ok = await patch(`/api/system/tenants/${t.id}`, { currency: 'eur', defaultTimezone: 'Europe/Paris' }, { token: tok });
    assert.equal(ok.status, 200, ok.text); assert.deepEqual([ok.json.tenant.currency, ok.json.tenant.default_timezone], ['EUR', 'Europe/Paris']);
    for (const bad of ['GB', 'POUND', 'g1p', 5, ['GBP'], '']) assert.equal((await patch(`/api/system/tenants/${t.id}`, { currency: bad }, { token: tok })).status, 400, JSON.stringify(bad));
    assert.equal((await patch(`/api/system/tenants/${t.id}`, { defaultTimezone: 'Nowhere/Land' }, { token: tok })).status, 400);
    assert.equal((await patch('/api/tenant/me', { currency: 'USD' }, { token: t.token })).json.tenant.currency, 'EUR', 'a customer cannot change their billing currency');
    await patch(`/api/system/tenants/${t.id}`, { currency: 'GBP', defaultTimezone: 'Europe/London' }, { token: tok });
    const loc = (await get('/api/tenant/locations', { token: t.token })).json.locations[0];
    const sysLoc = await patch(`/api/system/tenants/${t.id}/locations/${loc.id}`, { timezone: 'Africa/Nairobi' }, { token: tok });
    assert.equal(sysLoc.status, 200, sysLoc.text); assert.equal(sysLoc.json.location.timezone, 'Africa/Nairobi');
    assert.equal((await patch(`/api/system/tenants/${t.id}/locations/${loc.id}`, { timezone: 'nope' }, { token: tok })).status, 400);
    await patch(`/api/system/tenants/${t.id}/locations/${loc.id}`, { timezone: 'Europe/London' }, { token: tok });
  });
  it('platform billing config (currency, VAT rate and label) is served with the prices and validated; defaults are the UK values', async () => {
    const tok = await systemToken();
    const before = (await get('/api/system/pricing', { token: tok })).json;
    try {
      assert.deepEqual(before.billing, { currency: 'GBP', vatRate: 0.2, vatLabel: 'VAT' });
      assert.deepEqual((await get('/api/public/pricing')).json.billing, before.billing);
      assert.equal((await put('/api/system/pricing', { billing: { vatRate: 2 } }, { token: tok })).status, 400);
      assert.equal((await put('/api/system/pricing', { billing: { vatRate: -0.1 } }, { token: tok })).status, 400);
      assert.equal((await put('/api/system/pricing', { billing: { currency: 'pounds' } }, { token: tok })).status, 400);
      assert.equal((await put('/api/system/pricing', { billing: { vatLabel: 'x'.repeat(40) } }, { token: tok })).status, 400);
      assert.equal((await put('/api/system/pricing', { billing: 5 }, { token: tok })).status, 400);
      const ok = await put('/api/system/pricing', { billing: { currency: 'EUR', vatRate: 0.19, vatLabel: 'MwSt' } }, { token: tok });
      assert.equal(ok.status, 200, ok.text); assert.deepEqual(ok.json.billing, { currency: 'EUR', vatRate: 0.19, vatLabel: 'MwSt' });
      assert.deepEqual((await get('/api/public/pricing')).json.billing, { currency: 'EUR', vatRate: 0.19, vatLabel: 'MwSt' });
      assert.deepEqual((await get('/api/public/pricing')).json.pricing, before.pricing, 'prices are untouched');
    } finally { await put('/api/system/pricing', { billing: before.billing }, { token: tok }); }
    assert.deepEqual((await get('/api/public/pricing')).json.billing, before.billing);
  });
  it('System Admin reports carry no date at all (revenue is a sum over licences), so no zone applies to them', async () => {
    const r = (await get('/api/system/reports/overview', { token: await systemToken() })).json;
    assert.deepEqual(Object.keys(r).sort(), ['customerCount', 'deletedCustomerCount', 'deletedRevenue', 'pendingRevenue', 'revenueByPlan', 'totalLocations', 'totalRevenue']);
  });
});

// =====================================================================================
// E. TICKET NUMBERS
// =====================================================================================
describe('E. ticket numbers are unambiguous per location-day', () => {
  const D = '2026-11-10';
  let t, loc;
  before(async () => {
    await at(`${D}T08:00:00Z`);
    t = await signup('numbers', { locations: [{ name: 'Main' }, { name: 'Second' }], services: [{ name: 'Dental Care', locationIndex: 0 }] });
    loc = { main: t.locations.find((l) => l.name === 'Main'), second: t.locations.find((l) => l.name === 'Second') };
  });
  const prefixOf = (id) => sql(`select ticket_prefix from services where id='${id}'`);

  it('same-initial services at one location get different, stable prefixes: DC, DCA, DCB ...', async () => {
    const a = t.services[0];
    const b = await newService(t, loc.main.id, 'Dermal Clinic'); const c = await newService(t, loc.main.id, 'Diabetes Check');
    const d = await newService(t, loc.main.id, 'dental   chair');
    assert.deepEqual([a, b, c, d].map((s) => prefixOf(s.id)), ['DC', 'DCA', 'DCB', 'DCC']);
    assert.equal(prefixOf((await newService(t, loc.second.id, 'Dental Care')).id), 'DC', 'another location starts again from the plain initials');
    assert.equal(prefixOf((await newService(t, loc.main.id, 'X-Ray')).id), 'XR');
    assert.equal(prefixOf((await newService(t, loc.main.id, 'Pharmacy')).id), 'P');
    assert.equal(prefixOf((await newService(t, loc.main.id, '###')).id), 'SV', 'a name with no letters or digits falls back to SV');
    assert.equal(prefixOf((await newService(t, loc.main.id, 'Tests 24h')).id), 'T2');
  });
  it('renaming a service does not change its prefix (numbers stay stable), and an archived service keeps it reserved', async () => {
    const a = t.services[0];
    await patch(`/api/tenant/services/${a.id}`, { name: 'Eye Clinic' }, { token: t.token });
    assert.equal(prefixOf(a.id), 'DC');
    const b = (await get('/api/tenant/services', { token: t.token })).json.services.find((s) => s.name === 'Dermal Clinic');
    await patch(`/api/tenant/services/${b.id}`, { archived: true }, { token: t.token });
    const e = await newService(t, loc.main.id, 'Dental Cleaning');
    assert.notEqual(prefixOf(e.id), 'DCA', 'DCA is still Dermal Clinic\'s'); assert.equal(prefixOf(e.id), 'DCD');
  });
  it('tickets from services that share initials never repeat a number on the same location-day', async () => {
    const svcs = (await get('/api/tenant/services', { token: t.token })).json.services.filter((s) => s.location_id === loc.main.id && !s.archived && /^(Eye Clinic|Diabetes Check|dental\s+chair|Dental Cleaning)$/i.test(s.name));
    assert.equal(svcs.length, 4, JSON.stringify((await get('/api/tenant/services', { token: t.token })).json.services.map((s) => [s.name, s.archived, s.location_id === loc.main.id])));
    for (const s of svcs) await goLive(t, s, { plan: 'day', start: D, hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 2, walkInStaffCount: 8 } });
    const results = [];
    for (let round = 0; round < 3; round++) for (const s of svcs) results.push((await walkIn(t, s.id, D)).json.ticket);
    assert.ok(results.every(Boolean));
    const nums = results.map((x) => x.ticket_number);
    assert.equal(new Set(nums).size, nums.length, nums.join(' '));
    assert.deepEqual(nums.slice(0, 4), ['DC-001', 'DCB-001', 'DCC-001', 'DCD-001']);
    assert.deepEqual(results.filter((x) => x.service_id === svcs[0].id).map((x) => x.ticket_number), ['DC-001', 'DC-002', 'DC-003']);
    assert.ok(nums.every((n) => /^[A-Z0-9]{1,4}-\d{3}$/.test(n)), 'short and readable');
  });
  it('simultaneous joins across two services with a shared prefix never collide', async () => {
    const x = await newService(t, loc.second.id, 'Dermal Clinic'); const y = await newService(t, loc.second.id, 'Dental Care 2');
    assert.deepEqual([prefixOf(x.id), prefixOf(y.id)].sort(), ['DCA', 'DCB'].sort());
    for (const s of [x, y]) await goLive(t, s, { plan: 'day', start: D, hours: ALLDAY, staff: { staffCount: 40, bookingStaffCount: 2, walkInStaffCount: 38 } });
    const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => walkIn(t, i % 2 ? x.id : y.id, D)));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
    const nums = rs.map((r) => r.json.ticket.ticket_number);
    assert.equal(new Set(nums).size, 16, nums.join(' '));
  });
  it('the same number can exist at two LOCATIONS the same day (the display is only unique within a location), and the database enforces uniqueness within one', async () => {
    const sec = (await get('/api/tenant/services', { token: t.token })).json.services.find((s) => s.location_id === loc.second.id && s.name === 'Dental Care');
    await goLive(t, sec, { plan: 'day', start: D, hours: ALLDAY, staff: { staffCount: 10, bookingStaffCount: 1, walkInStaffCount: 9 } });
    const a = (await walkIn(t, sec.id, D)).json.ticket;
    assert.equal(a.ticket_number, 'DC-001'); assert.notEqual(a.location_id, t.services[0].location_id);
    assert.throws(() => sql(`insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status, visit_date) values ('${t.id}','${sec.id}','${sec.location_id}','DC-001','walk_in','waiting','${D}')`), /idx_tickets_location_day_number/);
    assert.match(sql(`select indexdef from pg_indexes where indexname='idx_tickets_location_day_number'`), /UNIQUE.*\(location_id, visit_date, ticket_number\)/);
    assert.match(sql(`select indexdef from pg_indexes where indexname='idx_services_location_ticket_prefix'`), /UNIQUE.*\(location_id, ticket_prefix\)/);
  });
  it('a ticket routed to a location where its number is already taken is renumbered (and told so in the log); otherwise it keeps its number', async () => {
    const svcs = (await get('/api/tenant/services', { token: t.token })).json.services;
    const mainDC = svcs.find((s) => s.location_id === loc.main.id && s.name === 'Eye Clinic'); // prefix DC
    const secDC = svcs.find((s) => s.location_id === loc.second.id && s.name === 'Dental Care');  // prefix DC, DC-001 already issued there
    const st = await addStaff(t);
    const n4 = (await walkIn(t, mainDC.id, D)).json.ticket; // DC-004 at Main
    const moved = await post(`/api/tenant/tickets/${n4.id}/route`, { newServiceId: secDC.id }, { token: st.token });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.json.ticket.location_id, loc.second.id); assert.equal(moved.json.ticket.ticket_number, 'DC-004', 'no clash at Second: keeps its number');
    const n5 = (await walkIn(t, mainDC.id, D)).json.ticket; // DC-005? -> use a clash instead:
    sql(`update tickets set ticket_number='DC-005' where id='${n5.id}'`);
    const atSecond = (await walkIn(t, secDC.id, D)).json.ticket; // some number at Second; make it DC-005
    sql(`update tickets set ticket_number='DC-005' where id='${atSecond.id}'`);
    const second = sqlJson(`select ticket_number from tickets where location_id='${loc.second.id}' and visit_date='${D}' and ticket_number like 'DC-%' order by ticket_number`).map((r) => r.ticket_number);
    assert.ok(second.includes('DC-005'));
    const moved2 = await post(`/api/tenant/tickets/${n5.id}/route`, { newServiceId: secDC.id }, { token: st.token });
    assert.equal(moved2.status, 200, moved2.text);
    assert.notEqual(moved2.json.ticket.ticket_number, 'DC-005'); assert.match(moved2.json.ticket.ticket_number, /^DC-\d{3}$/);
    const all = sqlJson(`select ticket_number from tickets where location_id='${loc.second.id}' and visit_date='${D}'`).map((r) => r.ticket_number);
    assert.equal(new Set(all).size, all.length);
    const log = (await get('/api/tenant/audit-log', { token: t.token })).json.auditLog;
    assert.ok(log.some((e) => /renumbered DC-\d{3} - that number was already used there today/.test(e.message)));
  });
  it('migration 0019 on live-shaped data: duplicates are renumbered (earliest keeps its number), logged, and the unique index then exists; re-running is harmless', () => {
    const scratch = `qb_br_${RUN}`;
    sql(`create database ${scratch}`, 'postgres');
    try {
      const run = (file) => execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', scratch, '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      // The schema as it was BEFORE 0019: the test schema with the 0019 block cut off.
      const full = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
      const cut = full.indexOf('-- 0019:');
      assert.ok(cut > 0, 'schema.sql carries the 0019 block');
      const pre = path.join('/tmp/gaps', `pre0019-${RUN}.sql`);
      fs.writeFileSync(pre, full.slice(0, cut)); run(pre);
      const S = (query) => sql(query, scratch);
      const tid = S(`insert into tenants (business_name,email,access_code,payment_method) values ('mig','mig@example.com','X','card') returning id`);
      const l1 = S(`insert into locations (tenant_id,name) values ('${tid}','L1') returning id`); const l2 = S(`insert into locations (tenant_id,name) values ('${tid}','L2') returning id`);
      const mk = (loc, name) => S(`insert into services (tenant_id,location_id,name) values ('${tid}','${loc}','${name}') returning id`);
      const a = mk(l1, 'Dental Care'), b = mk(l1, 'Dermal Clinic'), c = mk(l2, 'Dental Care');
      const tk = (svc, loc, num, at_) => S(`insert into tickets (tenant_id,service_id,location_id,ticket_number,type,visit_date,created_at) values ('${tid}','${svc}','${loc}','${num}','walk_in','2026-11-10','${at_}') returning id`);
      const t1 = tk(a, l1, 'DC-001', '2026-11-10 09:00'), t2 = tk(b, l1, 'DC-001', '2026-11-10 09:05'), t3 = tk(b, l1, 'DC-002', '2026-11-10 09:06'), t4 = tk(b, l1, 'DC-002', '2026-11-10 09:07'),
        t5 = tk(c, l2, 'DC-001', '2026-11-10 09:08');
      const sqlFile = path.join(SERVER_DIR, 'db/migrations/0019_timezones_currency_ticket_prefix.sql');
      run(sqlFile);
      const num = (id) => S(`select ticket_number from tickets where id='${id}'`);
      assert.equal(num(t1), 'DC-001', 'the earliest keeps its number'); assert.equal(num(t5), 'DC-001', 'another location is not a duplicate');
      assert.equal(num(t3), 'DC-002', 'the earlier of the two DC-002 keeps it');
      const renumbered = [num(t2), num(t4)];
      assert.ok(renumbered.every((n) => /^DC-\d{3}$/.test(n)) && !renumbered.includes('DC-001') && !renumbered.includes('DC-002') && new Set(renumbered).size === 2, renumbered.join());
      assert.equal(Number(S(`select count(*) from audit_log where tenant_id='${tid}' and message like '%renumbered to%'`)), 2);
      assert.equal(S(`select string_agg(ticket_prefix, ',' order by created_at) from services where location_id='${l1}'`), 'DC,DCA', 'the older service keeps the plain initials');
      assert.equal(S(`select ticket_prefix from services where id='${c}'`), 'DC');
      assert.equal(S(`select timezone from locations where id='${l1}'`), 'Europe/London');
      assert.equal(S(`select default_timezone || '/' || currency from tenants where id='${tid}'`), 'Europe/London/GBP');
      assert.equal(S(`select count(*) from platform_settings where key='billing'`), '1');
      run(sqlFile); // idempotent
      assert.equal(Number(S(`select count(*) from audit_log where tenant_id='${tid}' and message like '%renumbered to%'`)), 2, 'a second run changes nothing');
      assert.equal(S(`select count(*) from (select 1 from tickets group by location_id, visit_date, ticket_number having count(*) > 1) x`), '0');
    } finally { try { sql(`drop database if exists ${scratch}`, 'postgres'); } catch { /* best effort */ } }
  });
});

// =====================================================================================
// F. LICENCE STATUS IS NEVER STALE
// =====================================================================================
describe('F. licence status resolution', () => {
  const stored = (id) => sql(`select status from service_licenses where id='${id}'`);

  it('the patient service list never offers a service whose licence window is over, even while the stored status is still "active"', async () => {
    await at('2026-12-01T10:00:00Z');
    const t = await signup('stale'); const svc = t.services[0];
    const lic = await goLive(t, svc, { plan: 'day', start: '2026-12-01', hours: ALLDAY });
    assert.ok((await get(`${P(t)}/services`)).json.services.some((s) => s.id === svc.id));
    await at('2026-12-02T10:00:00Z'); // the window is over; nobody has resolved it
    assert.equal(stored(lic.id), 'active', 'the stored status is only a cache and is stale here');
    assert.equal((await get(`${P(t)}/services`)).json.services.some((s) => s.id === svc.id), false, 'the list applies the date rules itself');
    assert.equal(stored(lic.id), 'active', '(the listing is read-only)');
    assert.equal((await avail(t, svc.id, '2026-12-01')).open, false); // availability resolves it
    assert.equal(stored(lic.id), 'expired');
  });
  it('a service with dates but no hours drops off the list once its start day has passed, before anything has written the change', async () => {
    await at('2026-12-05T10:00:00Z');
    const t = await signup('nohours'); const svc = t.services[0];
    const lic = await buyLicence(t, svc.id, 'week');
    assert.equal((await patch(`/api/tenant/services/${svc.id}/licenses/${lic.id}`, { startDate: '2026-12-05' }, { token: t.token })).status, 200);
    assert.ok((await get(`${P(t)}/services`)).json.services.some((s) => s.id === svc.id), 'same-day set-up');
    await at('2026-12-06T10:00:00Z');
    assert.equal((await get(`${P(t)}/services`)).json.services.some((s) => s.id === svc.id), false);
    assert.equal(stored(lic.id), 'active');
    assert.equal(await licStatus(t, svc.id, lic.id), 'available', 'and the tenant\'s own list resolves it back to Available');
  });
  it('the sweep moves stale statuses along in each location\'s own zone, with no screen opened (system-admin and tenant views then agree)', async () => {
    process.env.DATABASE_URL = DATABASE_URL; process.env.DATABASE_SSL = 'false'; process.env.NODE_ENV = 'test';
    const lic = await import('../src/lib/serviceLicense.js');
    const clk = await import('../src/lib/clock.js');
    const pool = (await import('../src/db/pool.js')).pool;
    try {
      await at('2026-06-30T10:00:00Z');
      const t = await signup('sweep-lic', { locations: [{ name: 'London' }], services: [{ name: 'A London', locationIndex: 0 }] });
      const ny = await newLocation(t, 'NYC', 'America/New_York'); const nySvc = await newService(t, ny.id, 'A New York');
      const lonSvc = t.services[0];
      const lonDay = await goLive(t, lonSvc, { plan: 'day', start: '2026-07-01', hours: ALLDAY });
      const nyDay = await goLive(t, nySvc, { plan: 'day', start: '2026-07-01', hours: ALLDAY });
      const lonFuture = await buyLicence(t, lonSvc.id, 'week');
      assert.equal((await patch(`/api/tenant/services/${lonSvc.id}/licenses/${lonFuture.id}`, { startDate: '2026-07-02' }, { token: t.token })).status, 200);
      await putDay(t, lonSvc.id, '2026-07-03', { hours: [540] });
      assert.deepEqual([stored(lonDay.id), stored(nyDay.id), stored(lonFuture.id)], ['scheduled', 'scheduled', 'scheduled']);
      // 2 July 03:00Z: London is on the 2nd (day licence over, the week licence has begun), New York is still on the 1st (day licence running).
      clk.setTestNow('2026-07-02T03:00:00Z', { frozen: true });
      await lic.sweepLicences();
      assert.deepEqual([stored(lonDay.id), stored(nyDay.id), stored(lonFuture.id)], ['expired', 'active', 'active']);
      // 05:00Z: New York is on the 2nd, its day licence is over.
      clk.setTestNow('2026-07-02T05:00:00Z', { frozen: true });
      assert.ok((await lic.sweepLicences()) >= 1, 'New York\'s day licence changes (the count also includes any other stale licence in the shared test database)');
      assert.equal(stored(nyDay.id), 'expired');
      assert.equal(await lic.sweepLicences(), 0, 'nothing left to do: idempotent and cheap');
      // The same answers through every reader.
      const sysDetail = (await get(`/api/system/tenants/${t.id}/detail`, { token: await systemToken() })).json.licenses;
      assert.equal(sysDetail.find((l) => l.id === nyDay.id).status, 'expired');
      assert.equal(await licStatus(t, nySvc.id, nyDay.id), 'expired');
      const all = (await get('/api/tenant/licenses', { token: t.token })).json.licenses;
      assert.deepEqual(all.filter((l) => [lonDay.id, nyDay.id, lonFuture.id].includes(l.id)).map((l) => l.status).sort(), ['active', 'expired', 'expired']);
      // A licence with dates but no hours goes back to Available by the sweep on its first full day, in its own zone.
      clk.setTestNow('2026-06-30T10:00:00Z', { frozen: true });
      const none = await buyLicence(t, lonSvc.id, 'week');
      assert.equal((await patch(`/api/tenant/services/${lonSvc.id}/licenses/${none.id}`, { startDate: '2026-07-20' }, { token: t.token })).status, 200);
      sql(`update service_licenses set scheduled_at='2026-07-10T10:00:00Z' where id='${none.id}'`);
      clk.setTestNow('2026-07-19T23:30:00Z', { frozen: true }); // London 00:30 on the 20th
      await lic.sweepLicences();
      assert.equal(stored(none.id), 'available'); assert.equal(sql(`select start_date is null from service_licenses where id='${none.id}'`), 't');
    } finally { clk.clearTestNow(); delete process.env.NODE_ENV; await pool.end().catch(() => {}); }
  });
  it('mark-paid reports a freshly resolved licence', async () => {
    await at('2026-12-10T10:00:00Z');
    const t = await signup('markpaid'); const svc = t.services[0];
    const r = await post(`/api/tenant/services/${svc.id}/licenses`, { planId: 'day', paymentMethod: 'invoice', invoicePO: 'PO-1' }, { token: t.token });
    assert.equal(r.status, 200, r.text);
    const lic = r.json.license;
    assert.equal((await patch(`/api/tenant/services/${svc.id}/licenses/${lic.id}`, { startDate: '2026-12-10' }, { token: t.token })).status, 200);
    await putDay(t, svc.id, '2026-12-10', { hours: [540] });
    await at('2026-12-12T10:00:00Z');
    const mp = await post(`/api/system/tenants/${t.id}/licenses/${lic.id}/mark-paid`, {}, { token: await systemToken() });
    assert.equal(mp.status, 200, mp.text); assert.equal(mp.json.license.status, 'expired');
  });
});
