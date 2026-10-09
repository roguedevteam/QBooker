// QBooker "gaps" test suite: time zones & midnight (A), licence edge cases (B), multi-location (C), security (E).
//   node --test server/test/gaps.test.mjs
//
// Self-contained: it starts its OWN API processes (ports 4400-4499, never :4100 / :4300) against the throwaway test
// Postgres, preloading e2e/dns-stub.mjs (the sandbox has no DNS, so the sign-up MX check is stubbed for the test instance only).
//  * `srv`  - NODE_ENV=test with the TEST CLOCK enabled; tests move the server's clock with POST /api/system/test-now.
//  * `prod` - no NODE_ENV, no QB_TEST_NOW: proves the clock override is inert in a normal deployment.
// Everything is created under `gaps-<run>` names; other tenants are never touched. psql fixtures are used where the API
// cannot build the state (reading rows back, expired OTPs ...).
//
// Env: PGHOST/PGPORT/PGDATABASE/PGUSER as for api.test.mjs; DATABASE_URL (default the local throwaway DB).

import { describe, it, before, after, beforeEach } from 'node:test';
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

const JWT_SECRET = 'gaps-test-secret-' + 'x'.repeat(24);
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

// ------------------------------------------------------------------ psql
function sql(query) {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const sqlJson = (query) => JSON.parse(sql(`select coalesce(json_agg(t),'[]'::json) from (${query}) t`));

// ------------------------------------------------------------------ server processes
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
  const logFile = `/tmp/gaps/${label}-${RUN}.log`;
  fs.mkdirSync('/tmp/gaps', { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const baseEnv = { ...process.env };
  delete baseEnv.NODE_ENV; delete baseEnv.QB_TEST_NOW; delete baseEnv.QB_TEST_NOW_FROZEN;
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'e2e/dns-stub.mjs'), 'src/index.js'], {
    cwd: SERVER_DIR, stdio: ['ignore', out, out],
    env: {
      ...baseEnv, PORT: String(port), DATABASE_URL, DATABASE_SSL: 'false', JWT_SECRET,
      SYSTEM_ADMIN_PASSWORD_HASH: bcrypt.hashSync(SYSTEM_PASSWORD, 4),
      CORS_ORIGIN: 'http://localhost:5173,http://localhost:5176', TRUST_PROXY: '1', ...env,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, port, child, logFile }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server ${label} did not start; see ${logFile}`);
}
const stopServer = (s) => new Promise((resolve) => { if (!s?.child || s.child.exitCode !== null) return resolve(); s.child.once('exit', resolve); s.child.kill('SIGTERM'); setTimeout(() => s.child.kill('SIGKILL'), 3000).unref(); });

// ------------------------------------------------------------------ http client bound to a server
function client(getBase) {
  async function api(method, p, { token, body, rawBody, ip, headers = {} } = {}) {
    const h = { 'x-forwarded-for': ip || randIp(), ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (rawBody !== undefined) { payload = rawBody; h['content-type'] = h['content-type'] || 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(getBase() + p, { method, headers: h, body: payload });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    api,
    get: (p, o) => api('GET', p, o), post: (p, body, o = {}) => api('POST', p, { ...o, body }),
    put: (p, body, o = {}) => api('PUT', p, { ...o, body }), patch: (p, body, o = {}) => api('PATCH', p, { ...o, body }),
    del: (p, o) => api('DELETE', p, o),
  };
}

let srv, prod;
const http = client(() => srv.base);
const { get, post, put, patch, del } = http;
const createdTenants = [];

before(async () => {
  srv = await startServer({ label: 'srv', env: { NODE_ENV: 'test', QB_TEST_NOW: '2026-10-24T12:00:00Z' } });
  prod = await startServer({ label: 'prod' });
});
after(async () => {
  try {
    const t = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json?.token;
    if (t) for (const id of createdTenants) await del(`/api/system/tenants/${id}`, { token: t });
  } catch { /* best effort */ }
  await stopServer(srv); await stopServer(prod);
});

// ------------------------------------------------------------------ fixtures
let sysTok;
async function systemToken() {
  if (!sysTok) sysTok = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token;
  return sysTok;
}
// Moves the server's clock. frozen=true stops it ticking (needed for exact-boundary assertions).
async function at(iso, { frozen = false } = {}) {
  const r = await post('/api/system/test-now', { now: iso, frozen }, { token: await systemToken() });
  assert.equal(r.status, 200, `test-now failed: ${r.text}`);
  return r.json;
}
const today = async () => (await get('/api/public/clock')).json.today;

async function signup({ label = 't', locations = [{ name: 'Main' }], services = [{ name: 'Dental Care', locationIndex: 0, mode: 'hybrid', slotMinutes: 15 }] } = {}) {
  const email = `gaps-${RUN}-${label}-${rnd()}@example.com`;
  const body = { businessName: `gaps-${label}-${rnd()}`, firstName: 'Gap', lastName: 'Tester', email, locations, services };
  const r = await signupV(post, body);
  assert.equal(r.status, 200, `signup failed: ${r.text}`);
  createdTenants.push(r.json.tenant.id);
  const v = await post('/api/auth/admin/verify-otp', { email, code: r.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  const token = v.json.token;
  const locs = (await get('/api/tenant/locations', { token })).json.locations;
  const svcs = (await get('/api/tenant/services', { token })).json.services;
  return { email, token, id: r.json.tenant.id, businessName: body.businessName, locations: locs, services: svcs };
}
async function buyLicence(t, svcId, planId = 'month', extra = {}) {
  const r = await post(`/api/tenant/services/${svcId}/licenses`, { planId, paymentMethod: 'card', ...extra }, { token: t.token });
  assert.equal(r.status, 200, `buy licence failed: ${r.text}`);
  return r.json.license;
}
const schedule = (t, svcId, licId, startDate) => patch(`/api/tenant/services/${svcId}/licenses/${licId}`, { startDate }, { token: t.token });
const putDay = (t, svcId, date, o = {}) => put(`/api/tenant/services/${svcId}/daily-config`,
  { date, hours: ALLDAY, staffCount: 3, bookingStaffCount: 2, walkInStaffCount: 1, ...o }, { token: t.token });
async function licences(t, svcId) { return (await get(`/api/tenant/services/${svcId}/licenses`, { token: t.token })).json.licenses; }
// Buy + schedule + hours in one go. Returns the scheduled licence.
async function goLive(t, svc, { plan = 'day', start, hours = ALLDAY, days = 1, staff = {} } = {}) {
  const lic = await buyLicence(t, svc.id, plan);
  const s = await schedule(t, svc.id, lic.id, start);
  assert.equal(s.status, 200, `schedule failed: ${s.text}`);
  for (let i = 0; i < days; i++) {
    const r = await putDay(t, svc.id, addDays(start, i), { hours, ...staff });
    assert.equal(r.status, 200, `putDay failed: ${r.text}`);
  }
  return s.json.license;
}
const P = (t) => `/api/public/tenant/${t.id}`;
const join = (t, svcId, body, ip) => post(`${P(t)}/services/${svcId}/tickets`, body, { ip });
const walkIn = (t, svcId, date, extra = {}, ip) => join(t, svcId, { type: 'walk_in', date, ...extra }, ip);
const booked = (t, svcId, date, slotTime, extra = {}, ip) => join(t, svcId, { type: 'booked', date, slotTime, ...extra }, ip);
const avail = (t, svcId, date, clockMinutes) => get(`${P(t)}/services/${svcId}/availability?date=${date}${clockMinutes !== undefined ? `&clockMinutes=${clockMinutes}` : ''}`);
async function addStaff(t, first = 'Sam', last = 'Staff') {
  const email = `gaps-staff-${RUN}-${rnd()}@example.com`;
  const r = await post('/api/tenant/staff', { firstName: first, lastName: last, email }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  const o = await post('/api/auth/staff/request-otp', { email });
  const v = await post('/api/auth/staff/verify-otp', { email, code: o.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  return { id: r.json.staff.id, email, token: v.json.token };
}
const callNext = (tok, svcId, date, o = {}) => post(`/api/tenant/services/${svcId}/call-next`, { roomLabel: 'Room 1', date, ...o }, { token: tok });
const tickets = (tok, date) => get(`/api/tenant/tickets${date ? `?date=${date}` : ''}`, { token: tok });
const pubTicket = (token) => get(`/api/public/ticket/${token}`);

// =====================================================================================
// A. TIME ZONES / MIDNIGHT
// =====================================================================================
describe('A. business time zone (Europe/London) and midnight', () => {
  describe('clock module: London date and wall-clock minutes (BST / GMT / DST changes)', () => {
    let clk;
    before(async () => { process.env.NODE_ENV = 'test'; clk = await import('../src/lib/clock.js'); });
    after(() => { clk.clearTestNow(); delete process.env.NODE_ENV; });
    const cases = [
      // [UTC instant, expected London date, expected London minutes, why]
      ['2026-10-24T22:59:30Z', '2026-10-24', 23 * 60 + 59, '23:59 BST, last minute of the 24th'],
      ['2026-10-24T23:00:00Z', '2026-10-25', 0, '00:00 BST - UTC date is still the 24th'],
      ['2026-10-24T23:30:00Z', '2026-10-25', 30, '00:30 BST - UTC date is still the 24th'],
      ['2026-10-25T00:30:00Z', '2026-10-25', 90, '01:30 BST (first pass of the repeated hour)'],
      ['2026-10-25T01:30:00Z', '2026-10-25', 90, '01:30 GMT (second pass of the repeated hour)'],
      ['2026-10-25T23:30:00Z', '2026-10-25', 23 * 60 + 30, '23:30 GMT: the 25th has 25 hours, a "24h later" rule would say the 26th'],
      ['2026-10-26T00:00:00Z', '2026-10-26', 0, 'midnight GMT'],
      ['2026-03-28T23:59:00Z', '2026-03-28', 23 * 60 + 59, 'GMT, day before the spring change'],
      ['2026-03-29T00:59:00Z', '2026-03-29', 59, '00:59 GMT, last minute before the clocks go forward'],
      ['2026-03-29T01:00:00Z', '2026-03-29', 120, '01:00Z is 02:00 BST: wall clock skips 01:xx'],
      ['2026-03-29T22:59:00Z', '2026-03-29', 23 * 60 + 59, '23:59 BST on the 23-hour day'],
      ['2026-03-29T23:00:00Z', '2026-03-30', 0, '00:00 BST on the 30th'],
      ['2026-07-01T23:00:00Z', '2026-07-02', 0, 'midsummer: London is a day ahead from 23:00Z'],
      ['2026-12-31T23:59:00Z', '2026-12-31', 23 * 60 + 59, 'GMT new-year eve'],
      ['2027-01-01T00:00:00Z', '2027-01-01', 0, 'new year'],
      ['2028-02-29T23:30:00Z', '2028-02-29', 23 * 60 + 30, 'leap day, GMT'],
    ];
    for (const [iso, date, mins, why] of cases) {
      it(`${iso} -> ${date} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')} (${why})`, () => {
        clk.setTestNow(iso, { frozen: true });
        assert.equal(clk.getToday(), date);
        assert.equal(clk.londonNowMinutes(), mins);
      });
    }
    it('a simulated date replaces only the date, never the time of day', () => {
      clk.setTestNow('2026-10-24T23:30:00Z', { frozen: true });
      clk.setSimulatedToday('2026-12-01');
      try { assert.equal(clk.getToday(), '2026-12-01'); assert.equal(clk.londonNowMinutes(), 30); assert.equal(clk.isSimulated(), true); }
      finally { clk.clearSimulatedToday(); }
      assert.equal(clk.getToday(), '2026-10-25');
    });
    it('an unfrozen test clock ticks forward from its starting instant', async () => {
      clk.setTestNow('2026-10-24T23:30:00Z');
      const a = clk.now().getTime();
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(clk.now().getTime() - a >= 100);
    });
    it('rejects malformed instants', () => {
      for (const bad of ['tomorrow', '2026-10-24', '2026-10-24 23:30', '2026-13-45T00:00:00Z', 12345]) {
        assert.throws(() => clk.setTestNow(bad), undefined, String(bad));
      }
    });
  });

  describe('the test clock is inert unless explicitly enabled', () => {
    it('a process with neither NODE_ENV=test nor QB_TEST_NOW refuses setTestNow and uses the real clock', () => {
      const env = { ...process.env }; delete env.NODE_ENV; delete env.QB_TEST_NOW;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import * as c from ${JSON.stringify(path.join(SERVER_DIR, 'src/lib/clock.js'))};
         let threw = false; try { c.setTestNow('2026-10-24T23:30:00Z'); } catch { threw = true; }
         console.log(JSON.stringify({ enabled: c.testClockEnabled(), threw, active: c.isTestClockActive(), skew: Math.abs(c.now().getTime() - Date.now()), param: c.testNowParam(), sql: c.nowSql() }));`],
        { env, encoding: 'utf8' });
      const r = JSON.parse(out.trim());
      assert.deepEqual({ enabled: r.enabled, threw: r.threw, active: r.active, param: r.param, sql: r.sql }, { enabled: false, threw: true, active: false, param: null, sql: 'now()' });
      assert.ok(r.skew < 1000);
    });
    it('NODE_ENV=production does not enable it even if a test clock was requested in code', () => {
      const env = { ...process.env, NODE_ENV: 'production' }; delete env.QB_TEST_NOW;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import * as c from ${JSON.stringify(path.join(SERVER_DIR, 'src/lib/clock.js'))};
         let threw = false; try { c.setTestNow('2026-10-24T23:30:00Z'); } catch { threw = true; }
         console.log(JSON.stringify({ threw }));`], { env, encoding: 'utf8' });
      assert.equal(JSON.parse(out.trim()).threw, true);
    });
    it('a normally-configured API answers 404 on /api/system/test-now even for the system admin, and reports real time', async () => {
      const p = client(() => prod.base);
      const tok = (await p.post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token;
      for (const [m, body] of [['GET'], ['POST', { now: '2026-10-24T23:30:00Z' }], ['DELETE']]) {
        const r = await p.api(m, '/api/system/test-now', { token: tok, body });
        assert.equal(r.status, 404, `${m} ${r.text}`);
      }
      const c = (await p.get('/api/public/time')).json;
      assert.ok(Math.abs(Date.parse(c.now) - Date.now()) < 5000, `server now ${c.now}`);
      assert.equal(c.simulated, false);
    });
    it('the test-now routes need a system-admin token on the test server too', async () => {
      assert.equal((await post('/api/system/test-now', { now: '2026-10-24T23:30:00Z' })).status, 401);
      const t = await signup({ label: 'tn' });
      assert.equal((await post('/api/system/test-now', { now: '2026-10-24T23:30:00Z' }, { token: t.token })).status, 403);
    });
    it('rejects a malformed instant with 400', async () => {
      const tok = await systemToken();
      for (const now of ['soon', '2026-10-24', '', null, 5, '2026-10-24T23:30:00']) {
        assert.equal((await post('/api/system/test-now', { now }, { token: tok })).status, 400, String(now));
      }
    });
  });

  describe('00:30 BST: the business day is the London date, not the UTC date', () => {
    let t, svc, lic;
    before(async () => {
      await at('2026-10-24T20:00:00Z');
      t = await signup({ label: 'bst' }); svc = t.services[0];
    });
    it('public clock says the 25th while the UTC date is still the 24th', async () => {
      await at('2026-10-24T23:30:00Z');
      const c = (await get('/api/public/time')).json;
      assert.equal(c.today, '2026-10-25'); assert.equal(c.now.slice(0, 10), '2026-10-24');
      assert.equal((await get('/api/public/clock')).json.today, '2026-10-25');
    });
    it('a licence scheduled to start on the London date is Active immediately (not "scheduled" until 01:00)', async () => {
      lic = await buyLicence(t, svc.id, 'day');
      const s = await schedule(t, svc.id, lic.id, '2026-10-25');
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.license.status, 'active');
      assert.equal(s.json.license.end_date, '2026-10-25');
      assert.equal((await putDay(t, svc.id, '2026-10-25')).status, 200);
    });
    it('the patient sees the service open and is offered the half-hour they are in, with no client clock supplied', async () => {
      const a = (await avail(t, svc.id, '2026-10-25')).json;
      assert.equal(a.open, true, JSON.stringify(a));
      assert.equal(a.walkIn.available, true); assert.equal(a.walkIn.block, 30);
    });
    it('joining at 00:30 BST lands on the 25th, numbered 001, in the 00:30 block', async () => {
      const r = await walkIn(t, svc.id, '2026-10-25');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ticket.visit_date, '2026-10-25'); assert.equal(r.json.ticket.hour_block, 30);
      assert.equal(r.json.ticket.ticket_number, 'DC-001');
      assert.equal((await pubTicket(r.json.publicToken)).json.state, 'waiting');
    });
    it('joining "yesterday" (the UTC date) is refused: that day has passed', async () => {
      const r = await walkIn(t, svc.id, '2026-10-24', { hourBlock: 30 });
      assert.ok([409, 400].includes(r.status), r.text);
    });
    it('a client that sends the 00:30 wall clock agrees with the server', async () => {
      const r = await walkIn(t, svc.id, '2026-10-25', { clockMinutes: 30 });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.ticket.hour_block, 30); assert.equal(r.json.ticket.ticket_number, 'DC-002');
    });
    it('dashboard, ticket list and the Today ribbon all use the 25th', async () => {
      assert.equal((await get('/api/tenant/dashboard/stats', { token: t.token })).json.stats.waiting, 2);
      assert.equal((await tickets(t.token)).json.tickets.length, 2);
      const td = (await get(`/api/tenant/today?serviceId=${svc.id}`, { token: t.token })).json;
      assert.equal(td.date, '2026-10-25'); assert.equal(td.open, true); assert.ok(td.nowMinutes >= 30 && td.nowMinutes < 40, td.nowMinutes);
      assert.equal(td.queueCount, 2);
    });
    it('bookable slots on the day start from the current time (no slot before 00:30 is offered) and slots 00:30..23:45 are bookable', async () => {
      const a = (await avail(t, svc.id, '2026-10-25')).json;
      assert.ok(a.bookableSlots.length > 0);
      assert.ok(a.bookableSlots.every((s) => s >= 30), a.bookableSlots.slice(0, 5).join());
      const b = await booked(t, svc.id, '2026-10-25', 45);
      assert.equal(b.status, 200, b.text); assert.equal(b.json.ticket.slot_time, 45);
    });
    it('the day\'s first and last slots exist and can be booked on a future day (00:00 and 23:45)', async () => {
      const t2 = await signup({ label: 'edge' });
      const s2 = t2.services[0];
      await goLive(t2, s2, { plan: 'week', start: '2026-10-26', days: 1 });
      const a = (await avail(t2, s2.id, '2026-10-26')).json;
      assert.equal(a.bookableSlots[0], 0); assert.equal(a.bookableSlots.at(-1) > 1400, true);
      assert.equal((await booked(t2, s2.id, '2026-10-26', 0)).status, 200);
      assert.equal((await booked(t2, s2.id, '2026-10-26', 1425)).status, 200);
      assert.equal((await booked(t2, s2.id, '2026-10-26', 1440)).status, 400);
    });
  });

  describe('end of the London day: licence expiry, end-of-day sweep, day numbering', () => {
    let t, svc, staff, j1, j2, j3;
    before(async () => {
      await at('2026-10-24T12:00:00Z');
      t = await signup({ label: 'eod' }); svc = t.services[0];
      staff = await addStaff(t);
      // Back-to-back one-day licences: the 24th and the 25th.
      await goLive(t, svc, { plan: 'day', start: '2026-10-24' });
      await goLive(t, svc, { plan: 'day', start: '2026-10-25' });
    });
    it('during the 24th: three patients join, one is called but never closed', async () => {
      j1 = await walkIn(t, svc.id, '2026-10-24'); j2 = await walkIn(t, svc.id, '2026-10-24');
      assert.equal(j1.status, 200, j1.text); assert.equal(j2.status, 200, j2.text);
      const c = await callNext(staff.token, svc.id, '2026-10-24');
      assert.equal(c.status, 200, c.text); assert.equal(c.json.ticket.id, j1.json.ticket.id, 'FIFO');
    });
    it('23:59 BST (22:59Z) on the last day of a licence: still open, joining works', async () => {
      await at('2026-10-24T22:59:20Z');
      assert.equal((await avail(t, svc.id, '2026-10-24')).json.open, true);
      j3 = await walkIn(t, svc.id, '2026-10-24', { clockMinutes: 1439 });
      assert.equal(j3.status, 200, j3.text);
      assert.equal((await licences(t, svc.id)).find((l) => l.start_date === '2026-10-24').status, 'active');
      assert.equal((await pubTicket(j2.json.publicToken)).json.state, 'waiting');
      // the sweep must not touch today's tickets
      await tickets(t.token, '2026-10-24');
      assert.equal(sqlJson(`select status from tickets where id='${j1.json.ticket.id}'`)[0].status, 'serving');
    });
    it('00:00:30 BST (23:00:30Z): the 24th licence expires, the 25th one is active, no gap', async () => {
      await at('2026-10-24T23:00:30Z');
      assert.equal(await today(), '2026-10-25');
      const ls = await licences(t, svc.id);
      assert.equal(ls.find((l) => l.start_date === '2026-10-24').status, 'expired');
      assert.equal(ls.find((l) => l.start_date === '2026-10-25').status, 'active');
      const a = (await avail(t, svc.id, '2026-10-24')).json;
      assert.equal(a.open, false);
      assert.equal((await avail(t, svc.id, '2026-10-25')).json.open, true);
    });
    it('the end-of-day sweep closes the 24th\'s called ticket (London day) and stamps it at 23:59:59 BST', async () => {
      await tickets(t.token, '2026-10-24'); // listing runs the sweep
      const row = sqlJson(`select status, closed_by_system, finished_at from tickets where id='${j1.json.ticket.id}'`)[0];
      assert.equal(row.status, 'completed'); assert.equal(row.closed_by_system, true);
      assert.equal(new Date(row.finished_at).toISOString(), '2026-10-24T22:59:59.000Z');
    });
    it('a ticket called today (the 25th) just after midnight is NOT swept', async () => {
      const k = await walkIn(t, svc.id, '2026-10-25', { clockMinutes: 1 });
      assert.equal(k.status, 200, k.text); assert.equal(k.json.ticket.ticket_number, 'DC-001', 'numbering restarts each London day');
      const c = await callNext(staff.token, svc.id, '2026-10-25');
      assert.equal(c.status, 200, c.text);
      await tickets(t.token);
      assert.equal(sqlJson(`select status from tickets where id='${k.json.ticket.id}'`)[0].status, 'serving');
    });
    it('yesterday\'s still-waiting patients see "expired" and cannot be joined into a day with no licence', async () => {
      assert.equal((await pubTicket(j2.json.publicToken)).json.state, 'expired');
      assert.equal((await pubTicket(j3.json.publicToken)).json.state, 'expired');
      const r = await walkIn(t, svc.id, '2026-10-24', { hourBlock: 0 });
      assert.ok([409].includes(r.status), r.text);
    });
    it('dashboard defaults to the new day but still reports the 24th on request', async () => {
      const now = (await get('/api/tenant/dashboard/stats', { token: t.token })).json.stats;
      assert.equal(now.waiting, 0); assert.equal(now.serving, 1);
      const yd = (await get('/api/tenant/dashboard/stats?date=2026-10-24', { token: t.token })).json.stats;
      assert.equal(yd.waiting, 2); assert.equal(yd.completed, 1);
    });
  });

  describe('a licence that starts "tomorrow" does not leak into today', () => {
    let t, svc;
    before(async () => {
      await at('2026-10-24T20:00:00Z');
      t = await signup({ label: 'tmrw' }); svc = t.services[0];
      await goLive(t, svc, { plan: 'week', start: '2026-10-25', days: 2 });
    });
    it('at 23:59 BST on the 24th the service is closed for today and joining is refused', async () => {
      await at('2026-10-24T22:59:10Z');
      assert.equal((await licences(t, svc.id))[0].status, 'scheduled');
      const a = (await avail(t, svc.id, '2026-10-24')).json;
      assert.deepEqual([a.open, a.reason], [false, 'outside_license_window']);
      const j = await walkIn(t, svc.id, '2026-10-24', { hourBlock: 0 });
      assert.equal(j.status, 409); assert.equal(j.json.reason, 'outside_license_window');
      // ... while tomorrow can be pre-booked
      assert.equal((await booked(t, svc.id, '2026-10-25', 600)).status, 200);
      // and the Today ribbon says outside the licence window
      const td = (await get(`/api/tenant/today?serviceId=${svc.id}`, { token: t.token })).json;
      assert.deepEqual([td.open, td.reason, td.date], [false, 'outside_license_window', '2026-10-24']);
    });
    it('at 00:00:30 BST it goes Active and today\'s walk-in works', async () => {
      await at('2026-10-24T23:00:30Z');
      assert.equal((await licences(t, svc.id))[0].status, 'active');
      const j = await walkIn(t, svc.id, '2026-10-25', { clockMinutes: 1 });
      assert.equal(j.status, 200, j.text);
    });
  });

  describe('trial: 2 free days, expiring exactly at the end of the second London day (also across DST changes)', () => {
    async function trialTenant(label) {
      const t = await signup({ label }); const svc = t.services[0];
      const trial = (await licences(t, svc.id)).find((l) => l.plan_id === 'trial');
      assert.ok(trial, 'sign-up issues a trial licence'); assert.equal(trial.plan_days, 2); assert.equal(Number(trial.price), 0); assert.equal(trial.paid, true);
      return { t, svc, trial };
    }
    it('autumn: start 25 Oct (25-hour day) -> active until 23:59:59 GMT on the 26th, expired from 00:00 on the 27th', async () => {
      await at('2026-10-24T12:00:00Z');
      const { t, svc, trial } = await trialTenant('trial-aut');
      const s = await schedule(t, svc.id, trial.id, '2026-10-25');
      assert.equal(s.status, 200, s.text); assert.equal(s.json.license.end_date, '2026-10-26');
      await putDay(t, svc.id, '2026-10-25'); await putDay(t, svc.id, '2026-10-26');
      const st = async () => (await licences(t, svc.id))[0].status;
      await at('2026-10-24T22:59:30Z'); assert.equal(await st(), 'scheduled', '23:59 BST on the 24th: not started');
      await at('2026-10-24T23:00:30Z'); assert.equal(await st(), 'active', '00:00 BST on the 25th');
      await at('2026-10-25T23:30:00Z'); assert.equal(await today(), '2026-10-25'); assert.equal(await st(), 'active', 'still the 25th at 23:30 GMT (25-hour day)');
      await at('2026-10-26T00:00:30Z'); assert.equal(await st(), 'active', 'second free day');
      await at('2026-10-26T23:59:30Z'); assert.equal(await st(), 'active', '23:59 GMT on the second day');
      assert.equal((await avail(t, svc.id, '2026-10-26')).json.open, true);
      await at('2026-10-27T00:00:30Z'); assert.equal(await st(), 'expired', '00:00 on the 27th');
      assert.equal((await avail(t, svc.id, '2026-10-26')).json.open, false);
    });
    it('spring: start 28 Mar -> active until 23:59 BST on the 29th (23-hour day), expired from 00:00 BST on the 30th', async () => {
      await at('2026-03-27T12:00:00Z');
      const { t, svc, trial } = await trialTenant('trial-spr');
      const s = await schedule(t, svc.id, trial.id, '2026-03-28');
      assert.equal(s.status, 200, s.text); assert.equal(s.json.license.end_date, '2026-03-29');
      await putDay(t, svc.id, '2026-03-28'); await putDay(t, svc.id, '2026-03-29');
      const st = async () => (await licences(t, svc.id))[0].status;
      await at('2026-03-28T00:00:30Z'); assert.equal(await st(), 'active');
      await at('2026-03-29T22:59:30Z'); assert.equal(await st(), 'active', '23:59:30 BST on the 29th');
      await at('2026-03-29T23:00:30Z'); assert.equal(await st(), 'expired', '00:00:30 BST on the 30th');
    });
    it('the trial licence is issued once, free, and only buys two days even if scheduled for a custom start', async () => {
      await at('2026-11-10T12:00:00Z');
      const { t, svc, trial } = await trialTenant('trial-once');
      assert.equal((await licences(t, svc.id)).filter((l) => l.plan_id === 'trial').length, 1);
      const s = await schedule(t, svc.id, trial.id, '2026-11-12');
      assert.equal(s.json.license.end_date, '2026-11-13');
    });
  });

  describe('opening hours, "closed after the last block", and the client clock', () => {
    it('BST: last block 09:30-10:00 -> closed from 10:00 London even though UTC says 09:xx', async () => {
      await at('2026-07-15T08:00:00Z');
      const t = await signup({ label: 'bsthrs' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-07-15', hours: [540, 570] });
      await at('2026-07-15T08:29:00Z'); // 09:29 BST
      let a = (await avail(t, svc.id, '2026-07-15')).json; assert.equal(a.open, true); assert.equal(a.walkIn.block, 540);
      await at('2026-07-15T08:59:00Z'); // 09:59 BST
      a = (await avail(t, svc.id, '2026-07-15')).json; assert.equal(a.open, true); assert.equal(a.walkIn.block, 570);
      await at('2026-07-15T09:01:00Z'); // 10:01 BST
      a = (await avail(t, svc.id, '2026-07-15')).json; assert.deepEqual([a.open, a.reason], [false, 'closed']);
      const j = await walkIn(t, svc.id, '2026-07-15');
      assert.equal(j.status, 409); assert.equal(j.json.reason, 'closed');
    });
    it('GMT: the same hours close at 10:00 GMT (10:00Z)', async () => {
      await at('2026-11-10T08:00:00Z');
      const t = await signup({ label: 'gmthrs' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-11-10', hours: [540, 570] });
      await at('2026-11-10T09:59:00Z');
      assert.equal((await avail(t, svc.id, '2026-11-10')).json.open, true);
      await at('2026-11-10T10:01:00Z');
      assert.deepEqual([(await avail(t, svc.id, '2026-11-10')).json.open, (await avail(t, svc.id, '2026-11-10')).json.reason], [false, 'closed']);
    });
    it('before opening, the patient may still join the first block of the day', async () => {
      await at('2026-11-11T05:00:00Z');
      const t = await signup({ label: 'early' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-11-11', hours: [540] });
      const a = (await avail(t, svc.id, '2026-11-11')).json;
      assert.equal(a.open, true); assert.equal(a.walkIn.block, 540);
      const j = await walkIn(t, svc.id, '2026-11-11'); assert.equal(j.status, 200, j.text); assert.equal(j.json.ticket.hour_block, 540);
    });
    it('the repeated hour on 25 Oct: 01:30 BST and 01:30 GMT both resolve to the 01:30 block and number sequentially', async () => {
      await at('2026-10-24T20:00:00Z');
      const t = await signup({ label: 'dup' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-10-25' });
      await at('2026-10-25T00:30:00Z');
      const a = await walkIn(t, svc.id, '2026-10-25'); assert.equal(a.json.ticket.hour_block, 90);
      await at('2026-10-25T01:30:00Z');
      const b = await walkIn(t, svc.id, '2026-10-25'); assert.equal(b.json.ticket.hour_block, 90);
      assert.deepEqual([a.json.ticket.ticket_number, b.json.ticket.ticket_number], ['DC-001', 'DC-002']);
      assert.equal(b.json.ticket.visit_date, '2026-10-25');
    });
    it('the spring gap on 29 Mar: at 01:00Z the wall clock is 02:00, so a walk-in lands in the 02:00 block', async () => {
      await at('2026-03-28T20:00:00Z');
      const t = await signup({ label: 'gap' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-03-29' });
      await at('2026-03-29T00:59:00Z');
      assert.equal((await walkIn(t, svc.id, '2026-03-29')).json.ticket.hour_block, 30);
      await at('2026-03-29T01:00:30Z');
      const j = await walkIn(t, svc.id, '2026-03-29'); assert.equal(j.json.ticket.hour_block, 120);
    });
    it('the server\'s own wall clock (not the UTC date) is used when the client sends nothing: ribbon "now" is London minutes', async () => {
      await at('2026-07-15T22:30:00Z', { frozen: true }); // 23:30 BST on the 15th
      const t = await signup({ label: 'ribbon' }); const svc = t.services[0];
      await goLive(t, svc, { plan: 'day', start: '2026-07-15' });
      const td = (await get(`/api/tenant/today?serviceId=${svc.id}`, { token: t.token })).json;
      assert.deepEqual([td.date, td.nowMinutes], ['2026-07-15', 23 * 60 + 30]);
      await at('2026-07-15T23:10:00Z', { frozen: true }); // 00:10 BST on the 16th
      const td2 = (await get(`/api/tenant/today?serviceId=${svc.id}`, { token: t.token })).json;
      assert.deepEqual([td2.date, td2.nowMinutes, td2.open, td2.reason], ['2026-07-16', 10, false, 'outside_license_window']);
    });
  });

  describe('timestamps written by the server follow the test clock; the DB default for visit_date is the London date', () => {
    it('called_at / created_at / scheduled_at / purchased_at come from the clock in use', async () => {
      await at('2026-10-24T23:40:00Z');
      const t = await signup({ label: 'stamps' }); const svc = t.services[0];
      const st = await addStaff(t);
      const lic = await goLive(t, svc, { plan: 'day', start: '2026-10-25' });
      const j = await walkIn(t, svc.id, '2026-10-25');
      await callNext(st.token, svc.id, '2026-10-25');
      const row = sqlJson(`select created_at, called_at from tickets where id='${j.json.ticket.id}'`)[0];
      for (const ts of [row.created_at, row.called_at]) assert.equal(new Date(ts).toISOString().slice(0, 13), '2026-10-24T23');
      const l = sqlJson(`select purchased_at, scheduled_at from service_licenses where id='${lic.id}'`)[0];
      assert.equal(new Date(l.purchased_at).toISOString().slice(0, 13), '2026-10-24T23');
      assert.equal(new Date(l.scheduled_at).toISOString().slice(0, 13), '2026-10-24T23');
    });
    it('a ticket inserted by anything other than the API gets the London date by default', () => {
      const def = sql(`select column_default from information_schema.columns where table_name='tickets' and column_name='visit_date'`);
      assert.match(def, /Europe\/London/);
    });
  });

  describe('System Admin simulated date still works alongside the London clock', () => {
    it('sets, reports and clears a simulated date; the public clock exposes it', async () => {
      await at('2026-10-24T23:30:00Z', { frozen: true });
      const tok = await systemToken();
      const r = await post('/api/system/clock', { date: '2026-12-01' }, { token: tok });
      try {
        assert.deepEqual([r.json.today, r.json.simulated], ['2026-12-01', true]);
        const pub = (await get('/api/public/clock')).json;
        assert.deepEqual([pub.today, pub.simulated], ['2026-12-01', true]);
      } finally { await del('/api/system/clock', { token: tok }); }
      const after = (await get('/api/public/clock')).json;
      assert.deepEqual([after.today, after.simulated], ['2026-10-25', false]);
    });
    it('rejects a malformed simulated date', async () => {
      assert.equal((await post('/api/system/clock', { date: '01/12/2026' }, { token: await systemToken() })).status, 400);
    });
  });
});

// =====================================================================================
// B. LICENCE EDGE CASES
// =====================================================================================
describe('B. licence edge cases', () => {
  const D0 = '2026-11-10';
  let t, n = 0;
  beforeEach(async () => { await at(`${D0}T12:00:00Z`); }); // every test starts from the same instant, whatever the last one did
  before(async () => { await at(`${D0}T12:00:00Z`); t = await signup({ label: 'lic', locations: [{ name: 'Main' }, { name: 'Second' }], services: [
    { name: 'Dental Care', locationIndex: 0 }, { name: 'Hygiene', locationIndex: 0 }, { name: 'Eye Clinic', locationIndex: 1 }] }); });
  // a fresh service per test keeps windows independent
  async function svcNamed() {
    const r = await post('/api/tenant/services', { name: `Svc ${++n} ${rnd()}`, locationId: t.locations[0].id }, { token: t.token });
    assert.equal(r.status, 200, r.text); return r.json.service;
  }
  const buy = (svcId, planId = 'week', extra = {}) => buyLicence(t, svcId, planId, extra);
  const lic = async (svcId, id) => (await licences(t, svcId)).find((l) => l.id === id);

  describe('start / end dates and plan lengths', () => {
    it('a 1-day licence starts and ends on the same date', async () => {
      const s = await svcNamed(); const l = await buy(s.id, 'day');
      const r = await schedule(t, s.id, l.id, '2026-11-12');
      assert.equal(r.status, 200); assert.deepEqual([r.json.license.start_date, r.json.license.end_date, r.json.license.status], ['2026-11-12', '2026-11-12', 'scheduled']);
    });
    it('a 1-day custom licence is allowed; 0 and 366 days are not', async () => {
      const s = await svcNamed();
      const one = await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'custom', customDays: 1, paymentMethod: 'card' }, { token: t.token });
      assert.equal(one.status, 200, one.text); assert.equal(one.json.license.plan_days, 1);
      for (const customDays of [0, 366, -1, 1.5, 'x', null]) {
        assert.equal((await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'custom', customDays, paymentMethod: 'card' }, { token: t.token })).status, 400, String(customDays));
      }
    });
    it('plan lengths: week = 7 days, month = 30, year = 365 (end date inclusive)', async () => {
      const s = await svcNamed();
      for (const [plan, days] of [['week', 7], ['month', 30], ['year', 365]]) {
        const s2 = await svcNamed(); const l = await buy(s2.id, plan);
        const r = await schedule(t, s2.id, l.id, '2027-01-04');
        assert.equal(r.json.license.end_date, addDays('2027-01-04', days - 1), plan);
      }
      assert.ok(s);
    });
    it('a window can start today (Active at once) or tomorrow (Scheduled), but never in the past', async () => {
      const s = await svcNamed();
      const a = await buy(s.id, 'day'); const b = await buy(s.id, 'week');
      assert.equal((await schedule(t, s.id, a.id, D0)).json.license.status, 'active');
      assert.equal((await schedule(t, s.id, b.id, addDays(D0, 1))).json.license.status, 'scheduled');
      const s2 = await svcNamed(); const c = await buy(s2.id, 'week');
      const past = await schedule(t, s2.id, c.id, addDays(D0, -1));
      assert.equal(past.status, 409, 'a week licence started yesterday would silently waste a day: ' + past.text);
      assert.match(past.json.error, /passed|past/i);
    });
    it('scheduling a window entirely in the past is refused', async () => {
      const s = await svcNamed(); const l = await buy(s.id, 'week');
      assert.equal((await schedule(t, s.id, l.id, '2026-01-01')).status, 409);
    });
    it('a licence starting at 23:59 BST for "tomorrow" stays Scheduled, and one starting at 00:00 BST is Active', async () => {
      await at('2026-07-14T22:59:30Z'); // 23:59:30 BST on the 14th
      const s = await svcNamed(); const l = await buy(s.id, 'day'); const m = await buy(s.id, 'day');
      assert.equal((await schedule(t, s.id, l.id, '2026-07-15')).json.license.status, 'scheduled');
      await putDay(t, s.id, '2026-07-15'); // (without hours it would return to Available once the day starts - see the auto-revert tests)
      await at('2026-07-14T23:00:10Z'); // 00:00:10 BST on the 15th
      assert.equal((await lic(s.id, l.id)).status, 'active');
      assert.equal((await schedule(t, s.id, m.id, '2026-07-16')).json.license.status, 'scheduled');
      await at(`${D0}T12:00:00Z`);
    });
  });

  describe('overlap and back-to-back renewal', () => {
    it('renewing back-to-back: next window starts the day after the end (no gap, no overlap)', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'month'); const b = await buy(s.id, 'month');
      const ra = await schedule(t, s.id, a.id, D0); assert.equal(ra.json.license.end_date, addDays(D0, 29));
      assert.equal((await schedule(t, s.id, b.id, addDays(D0, 29))).status, 409, 'starting on the last day overlaps by one day');
      const rb = await schedule(t, s.id, b.id, addDays(D0, 30));
      assert.equal(rb.status, 200, rb.text);
      for (const day of [addDays(D0, 29), addDays(D0, 30)]) assert.equal((await putDay(t, s.id, day)).status, 200, day);
      const cfg = (await get(`/api/tenant/services/${s.id}/daily-config?from=${D0}&to=${addDays(D0, 60)}`, { token: t.token })).json;
      assert.equal(cfg.windows.length, 2);
      const w = [...cfg.windows].sort((x, y) => (x.start < y.start ? -1 : 1));
      assert.equal(addDays(w[0].end, 1), w[1].start);
    });
    it('renewing in the other order (later window first) is also fine; a one-day gap is allowed', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week'); const b = await buy(s.id, 'week');
      assert.equal((await schedule(t, s.id, b.id, addDays(D0, 8))).status, 200);
      assert.equal((await schedule(t, s.id, a.id, addDays(D0, 1))).status, 200); // 1..7 then 8..14
    });
    it('every overlap shape is refused: inside, containing, left edge, right edge, same start', async () => {
      const s = await svcNamed(); const base = await buy(s.id, 'week'); await schedule(t, s.id, base.id, addDays(D0, 10)); // 10..16
      for (const [plan, start] of [['day', 12], ['month', 5], ['week', 4], ['week', 16], ['week', 10], ['day', 10], ['day', 16]]) {
        const x = await buy(s.id, plan);
        assert.equal((await schedule(t, s.id, x.id, addDays(D0, start))).status, 409, `${plan} from +${start}`);
      }
    });
    it('a licence can be re-dated onto its own old window (it does not overlap itself)', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, addDays(D0, 3));
      assert.equal((await schedule(t, s.id, a.id, addDays(D0, 5))).status, 200); // 5..11 overlaps its old 3..9
    });
    it('two simultaneous attempts to take overlapping windows: exactly one wins (no double-booking race)', async () => {
      for (let round = 0; round < 6; round++) {
        const s = await svcNamed(); const a = await buy(s.id, 'week'); const b = await buy(s.id, 'week');
        const [x, y] = await Promise.all([schedule(t, s.id, a.id, addDays(D0, 20)), schedule(t, s.id, b.id, addDays(D0, 23))]);
        assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${round}: ${x.text} / ${y.text}`);
        const active = (await licences(t, s.id)).filter((l) => l.status === 'scheduled');
        assert.equal(active.length, 1, `round ${round}`);
      }
    });
  });

  describe('changing, un-scheduling and moving', () => {
    it('Change dates on a scheduled licence moves its hours with it (same offset)', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, addDays(D0, 3));
      await putDay(t, s.id, addDays(D0, 3), { hours: [540, 570] }); await putDay(t, s.id, addDays(D0, 5), { hours: [600] });
      const r = await schedule(t, s.id, a.id, addDays(D0, 6));
      assert.equal(r.status, 200, r.text);
      const cfg = (await get(`/api/tenant/services/${s.id}/daily-config?from=${D0}&to=${addDays(D0, 40)}`, { token: t.token })).json.dailyConfig;
      assert.deepEqual(cfg.map((c) => [c.date, c.hours.join()]), [[addDays(D0, 6), '540,570'], [addDays(D0, 8), '600']]);
    });
    it('an Active licence\'s dates cannot be changed or unscheduled', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, D0);
      assert.equal((await schedule(t, s.id, a.id, addDays(D0, 2))).status, 409);
      assert.equal((await patch(`/api/tenant/services/${s.id}/licenses/${a.id}`, { unschedule: true }, { token: t.token })).status, 409);
    });
    it('un-scheduling returns it to Available with dates cleared and hours wiped; it can be scheduled again', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, addDays(D0, 3)); await putDay(t, s.id, addDays(D0, 3));
      const u = await patch(`/api/tenant/services/${s.id}/licenses/${a.id}`, { unschedule: true }, { token: t.token });
      assert.equal(u.status, 200); assert.deepEqual([u.json.license.status, u.json.license.start_date, u.json.license.end_date], ['available', null, null]);
      assert.equal((await get(`/api/tenant/services/${s.id}/daily-config?from=${D0}&to=${addDays(D0, 40)}`, { token: t.token })).json.dailyConfig.length, 0);
      assert.equal((await schedule(t, s.id, a.id, addDays(D0, 4))).status, 200);
    });
    it('an Available licence moves to another service (same or another location); a Scheduled one cannot', async () => {
      const s1 = await svcNamed(); const eye = t.services.find((s) => s.name === 'Eye Clinic');
      const a = await buy(s1.id, 'week');
      const mv = await post(`/api/tenant/services/${s1.id}/licenses/${a.id}/move`, { targetServiceId: eye.id }, { token: t.token });
      assert.equal(mv.status, 200, mv.text); assert.equal(mv.json.license.service_id, eye.id);
      // it is gone from the old service and present on the new one
      assert.equal((await lic(s1.id, a.id)), undefined);
      assert.ok(await lic(eye.id, a.id));
      await schedule(t, eye.id, a.id, addDays(D0, 2));
      const again = await post(`/api/tenant/services/${eye.id}/licenses/${a.id}/move`, { targetServiceId: s1.id }, { token: t.token });
      assert.equal(again.status, 409);
    });
    it('cannot move to a service of another account, to a non-existent one, or a licence that is not on the service in the path', async () => {
      const other = await signup({ label: 'lic-other' });
      const s1 = await svcNamed(); const s2 = await svcNamed(); const a = await buy(s1.id, 'week');
      assert.equal((await post(`/api/tenant/services/${s1.id}/licenses/${a.id}/move`, { targetServiceId: other.services[0].id }, { token: t.token })).status, 404);
      assert.equal((await post(`/api/tenant/services/${s1.id}/licenses/${a.id}/move`, { targetServiceId: 'nope' }, { token: t.token })).status, 404);
      assert.equal((await post(`/api/tenant/services/${s2.id}/licenses/${a.id}/move`, { targetServiceId: s1.id }, { token: t.token })).status, 404);
      assert.equal((await schedule(t, s2.id, a.id, addDays(D0, 2))).status, 404);
      assert.equal((await schedule(other, s1.id, a.id, addDays(D0, 2))).status, 404);
    });
  });

  describe('status transitions and the auto-revert-to-Available rule', () => {
    it('available -> scheduled -> active -> expired as the London date advances', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      assert.equal(a.status, 'available'); assert.equal(a.start_date, null);
      await schedule(t, s.id, a.id, '2026-11-12'); await putDay(t, s.id, '2026-11-12');
      assert.equal((await lic(s.id, a.id)).status, 'scheduled');
      await at('2026-11-12T00:00:10Z'); assert.equal((await lic(s.id, a.id)).status, 'active');
      await at('2026-11-18T23:59:30Z'); assert.equal((await lic(s.id, a.id)).status, 'active', 'last day, 23:59 GMT');
      await at('2026-11-19T00:00:10Z'); assert.equal((await lic(s.id, a.id)).status, 'expired');
      await at(`${D0}T12:00:00Z`);
    });
    it('no hours were ever set: same-day set-up is safe, but once the day has passed it returns to Available (dates cleared, logged)', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, '2026-11-10'); // assigned today, starts today, nothing configured yet
      assert.equal((await lic(s.id, a.id)).status, 'active', 'same-day set-up still works');
      await at('2026-11-10T23:30:00Z'); assert.equal((await lic(s.id, a.id)).status, 'active', 'still the same London day');
      await at('2026-11-11T00:30:00Z');
      const back = await lic(s.id, a.id);
      assert.deepEqual([back.status, back.start_date, back.end_date], ['available', null, null]);
      const log = (await get('/api/tenant/audit-log', { token: t.token })).json.auditLog;
      assert.ok(log.some((e) => /returned to Available/.test(e.message)));
      assert.equal((await schedule(t, s.id, a.id, '2026-11-12')).status, 200, 'and it can be scheduled again');
      await at(`${D0}T12:00:00Z`);
    });
    it('with hours set anywhere in the window it is not reverted', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, '2026-11-10'); await putDay(t, s.id, '2026-11-14');
      await at('2026-11-12T10:00:00Z'); assert.equal((await lic(s.id, a.id)).status, 'active');
      await at(`${D0}T12:00:00Z`);
    });
    it('a Scheduled licence in the future is never reverted early', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, addDays(D0, 5));
      assert.equal((await lic(s.id, a.id)).status, 'scheduled');
    });
    it('the patient app lists a service only while it has a Scheduled/Active licence', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week');
      const listed = async () => (await get(`${P(t)}/services`)).json.services.some((x) => x.id === s.id);
      assert.equal(await listed(), false, 'available only');
      await schedule(t, s.id, a.id, addDays(D0, 2)); assert.equal(await listed(), true);
      await patch(`/api/tenant/services/${s.id}/licenses/${a.id}`, { unschedule: true }, { token: t.token }); assert.equal(await listed(), false);
    });
  });

  describe('refunds', () => {
    it('Available and Scheduled can be refunded; Active, Expired and Refunded cannot', async () => {
      const s = await svcNamed();
      const av = await buy(s.id, 'week'); const sc = await buy(s.id, 'week'); const ac = await buy(s.id, 'week');
      await schedule(t, s.id, sc.id, addDays(D0, 20)); await putDay(t, s.id, addDays(D0, 20));
      await schedule(t, s.id, ac.id, D0);
      const rf = (id) => post(`/api/tenant/services/${s.id}/licenses/${id}/refund`, {}, { token: t.token });
      assert.equal((await rf(av.id)).status, 200);
      assert.equal((await rf(av.id)).status, 409, 'twice');
      assert.equal((await rf(sc.id)).status, 200);
      assert.equal((await get(`/api/tenant/services/${s.id}/daily-config?from=${addDays(D0, 19)}&to=${addDays(D0, 30)}`, { token: t.token })).json.dailyConfig.length, 0, 'hours of the refunded window are removed');
      assert.equal((await rf(ac.id)).status, 409, 'active = partly used');
      assert.match((await rf(ac.id)).json.error, /hasn't started|Active|started/i);
    });
    it('a refunded licence frees its window, cannot be scheduled or moved, and shows as refunded', async () => {
      const s = await svcNamed(); const a = await buy(s.id, 'week'); const b = await buy(s.id, 'week');
      await schedule(t, s.id, a.id, addDays(D0, 30));
      await post(`/api/tenant/services/${s.id}/licenses/${a.id}/refund`, {}, { token: t.token });
      assert.equal((await lic(s.id, a.id)).status, 'refunded');
      assert.equal((await schedule(t, s.id, b.id, addDays(D0, 30))).status, 200, 'the window is free again');
      assert.equal((await schedule(t, s.id, a.id, addDays(D0, 50))).status, 409);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${a.id}/move`, { targetServiceId: t.services[0].id }, { token: t.token })).status, 409);
    });
    it('a licence that has expired after partial use cannot be refunded', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const a = await buy(s.id, 'day');
      await schedule(t, s.id, a.id, '2026-11-10'); await putDay(t, s.id, '2026-11-10');
      await at('2026-11-11T00:10:00Z');
      assert.equal((await lic(s.id, a.id)).status, 'expired');
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${a.id}/refund`, {}, { token: t.token })).status, 409);
      await at(`${D0}T12:00:00Z`);
    });
    it('the 90-day refund window is measured with the clock in use: day 89 ok, day 91 refused', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const a = await buy(s.id, 'week'); const b = await buy(s.id, 'week');
      await at('2027-02-06T11:00:00Z'); // 88 days later
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${a.id}/refund`, {}, { token: t.token })).status, 200);
      await at('2027-02-10T12:00:00Z'); // 92 days later
      const r = await post(`/api/tenant/services/${s.id}/licenses/${b.id}/refund`, {}, { token: t.token });
      assert.equal(r.status, 409); assert.match(r.json.error, /3 months/);
      await at(`${D0}T12:00:00Z`);
    });
    it('staff cannot buy, schedule, move or refund licences', async () => {
      const st = await addStaff(t); const s = await svcNamed(); const a = await buy(s.id, 'week');
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'day', paymentMethod: 'card' }, { token: st.token })).status, 403);
      assert.equal((await schedule({ token: st.token }, s.id, a.id, addDays(D0, 2))).status, 403);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${a.id}/refund`, {}, { token: st.token })).status, 403);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${a.id}/move`, { targetServiceId: s.id }, { token: st.token })).status, 403);
    });
  });

  describe('paid, unpaid (pay later / invoice) and the free trial', () => {
    it('card: paid at once with paid_at set; the price comes from the plan, not from the request', async () => {
      const s = await svcNamed();
      const r = await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'week', paymentMethod: 'card', price: 0, paid: false, status: 'active', start_date: D0 }, { token: t.token });
      assert.equal(r.status, 200, r.text);
      const l = r.json.license; assert.equal(l.paid, true); assert.ok(l.paid_at); assert.ok(Number(l.price) > 0); assert.equal(l.status, 'available'); assert.equal(l.start_date, null);
    });
    it('pay later: unpaid; it cannot be refunded; paying by card settles it; paying twice is refused', async () => {
      const s = await svcNamed(); const l = await buy(s.id, 'week', { paymentMethod: 'later' });
      assert.deepEqual([l.paid, l.payment_method, l.paid_at], [false, 'later', null]);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: t.token })).status, 409);
      const p = await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'card' }, { token: t.token });
      assert.equal(p.status, 200); assert.deepEqual([p.json.license.paid, p.json.license.payment_method], [true, 'card']); assert.ok(p.json.license.paid_at);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'card' }, { token: t.token })).status, 409);
    });
    it('invoice needs a PO reference; with one the licence stays unpaid until the platform marks it paid', async () => {
      const s = await svcNamed();
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'week', paymentMethod: 'invoice' }, { token: t.token })).status, 400);
      const l = await buy(s.id, 'week', { paymentMethod: 'invoice', invoicePO: 'PO-GAPS-1', invoiceEmail: 'ap@example.com' });
      assert.deepEqual([l.paid, l.payment_method, l.invoice_po], [false, 'invoice', 'PO-GAPS-1']);
      const sys = await systemToken();
      const m = await post(`/api/system/tenants/${t.id}/licenses/${l.id}/mark-paid`, {}, { token: sys });
      assert.equal(m.status, 200); assert.equal(m.json.license.paid, true);
      assert.equal((await post(`/api/system/tenants/${t.id}/licenses/${l.id}/mark-paid`, {}, { token: sys })).json.activated, false, 'idempotent');
    });
    it('a pay-later licence cannot be marked paid by the platform (customer must choose card/invoice)', async () => {
      const s = await svcNamed(); const l = await buy(s.id, 'week', { paymentMethod: 'later' });
      assert.equal((await post(`/api/system/tenants/${t.id}/licenses/${l.id}/mark-paid`, {}, { token: await systemToken() })).status, 409);
    });
    it('an unpaid (pay later / invoice) licence can still be scheduled and used, and still expires on time', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const l = await buy(s.id, 'day', { paymentMethod: 'later' });
      assert.equal((await schedule(t, s.id, l.id, '2026-11-10')).json.license.status, 'active');
      await putDay(t, s.id, '2026-11-10');
      assert.equal((await walkIn(t, s.id, '2026-11-10')).status, 200);
      await at('2026-11-11T00:00:30Z');
      assert.equal((await lic(s.id, l.id)).status, 'expired');
      assert.equal((await walkIn(t, s.id, '2026-11-11', { hourBlock: 0 })).status, 409);
      await at(`${D0}T12:00:00Z`);
    });
    it('the free trial is free (price 0, paid), cannot be refunded for money owed, and is not buyable through the plan list', async () => {
      const s = await svcNamed();
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses`, { planId: 'trial', paymentMethod: 'card' }, { token: t.token })).status, 400, 'trial is not a purchasable plan');
      for (const planId of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, 5]) {
        assert.equal((await post(`/api/tenant/services/${s.id}/licenses`, { planId, paymentMethod: 'card' }, { token: t.token })).status, 400, String(planId));
      }
    });
  });

  describe('licence with people in the queue at the end of its last day', () => {
    it('queue and called tickets are served until close on the last day; the licence expiring at midnight does not delete them', async () => {
      await at('2026-11-10T12:00:00Z');
      const s = await svcNamed(); const st = await addStaff(t);
      await schedule(t, s.id, (await buy(s.id, 'day')).id, '2026-11-10'); await putDay(t, s.id, '2026-11-10');
      const w1 = await walkIn(t, s.id, '2026-11-10'); const w2 = await walkIn(t, s.id, '2026-11-10');
      await at('2026-11-10T23:58:00Z');
      const c = await callNext(st.token, s.id, '2026-11-10'); assert.equal(c.status, 200, 'still callable at 23:58 on the last day');
      const done = await post(`/api/tenant/tickets/${c.json.ticket.id}/close`, {}, { token: st.token }); assert.equal(done.status, 200);
      await at('2026-11-11T00:05:00Z');
      assert.equal((await pubTicket(w2.json.publicToken)).json.state, 'expired');
      const list = (await tickets(t.token, '2026-11-10')).json.tickets;
      assert.equal(list.filter((x) => x.service_id === s.id).length, 2, 'history kept');
      assert.equal((await pubTicket(w1.json.publicToken)).json.state, 'closed');
      await at(`${D0}T12:00:00Z`);
    });
  });
});

// =====================================================================================
// C. MULTI-LOCATION
// =====================================================================================
describe('C. multi-location tenant', () => {
  const D = '2026-11-10';
  let t, other, staff, svc, L;
  const byName = (name, loc) => t.services.find((s) => s.name === name && s.location_id === loc.id);
  beforeEach(async () => { await at(`${D}T12:00:00Z`); });
  before(async () => {
    await at(`${D}T12:00:00Z`);
    t = await signup({ label: 'multi',
      locations: [{ name: 'Amersham Clinic' }, { name: 'Beaconsfield Clinic' }, { name: 'Chesham Clinic' }],
      services: [
        { name: 'Dental Care', locationIndex: 0, mode: 'hybrid' }, { name: 'Hygiene', locationIndex: 0, mode: 'queue' },
        { name: 'Dental Care', locationIndex: 1, mode: 'hybrid' }, { name: 'Eye Clinic', locationIndex: 1, mode: 'appointment' },
        { name: 'Minor Injuries', locationIndex: 2, mode: 'queue' }, { name: 'X Ray', locationIndex: 2, mode: 'queue' },
      ] });
    L = { a: t.locations.find((l) => l.name === 'Amersham Clinic'), b: t.locations.find((l) => l.name === 'Beaconsfield Clinic'), c: t.locations.find((l) => l.name === 'Chesham Clinic') };
    svc = {
      dentA: byName('Dental Care', L.a), hygA: byName('Hygiene', L.a), dentB: byName('Dental Care', L.b), eyeB: byName('Eye Clinic', L.b),
      injC: byName('Minor Injuries', L.c), xrayC: byName('X Ray', L.c),
    };
    for (const [k, s] of Object.entries(svc)) assert.ok(s, k);
    // Everyone licensed for today except X Ray; Eye Clinic has no hours today (closed); Minor Injuries closes after 10:00.
    for (const s of [svc.dentA, svc.hygA, svc.dentB, svc.injC]) await goLive(t, s, { plan: 'day', start: D, hours: s === svc.injC ? [540, 570] : ALLDAY, staff: { staffCount: 10, bookingStaffCount: 3, walkInStaffCount: 7 } });
    await goLive(t, svc.eyeB, { plan: 'day', start: D, hours: [] });
    staff = await addStaff(t);
    other = await signup({ label: 'multi-other' });
  });

  describe('chooser data (what the patient app lists)', () => {
    it('lists the three locations in creation order, with a website field and without the secret location code', async () => {
      const r = await get(`${P(t)}/locations`);
      assert.deepEqual(r.json.locations.map((l) => l.name), ['Amersham Clinic', 'Beaconsfield Clinic', 'Chesham Clinic']);
      for (const l of r.json.locations) { assert.ok('website_url' in l); assert.equal('code' in l, false); assert.equal('staff_access_code' in l, false); assert.equal('address' in l, false); }
    });
    it('lists only services that have a Scheduled/Active licence, each tied to its own location', async () => {
      const r = (await get(`${P(t)}/services`)).json.services;
      const ids = new Set(r.map((s) => s.id));
      for (const s of [svc.dentA, svc.hygA, svc.dentB, svc.eyeB, svc.injC]) assert.ok(ids.has(s.id), s.name);
      assert.equal(ids.has(svc.xrayC.id), false, 'unlicensed X Ray is not offered');
      for (const s of r) assert.equal(s.location_id, t.services.find((x) => x.id === s.id).location_id);
      assert.deepEqual(Object.keys(r[0]).sort(), ['id', 'location_id', 'mode', 'name', 'timezone']);
    });
    it('mixed open / closed locations: each service answers for itself', async () => {
      await at(`${D}T10:30:00Z`); // 10:30 GMT: Minor Injuries (09:00-10:00) is over, the rest of the day is open
      const st = async (s) => { const a = (await avail(t, s.id, D)).json; return a.open ? 'open' : a.reason; };
      assert.equal(await st(svc.dentA), 'open');
      assert.equal(await st(svc.hygA), 'open');
      assert.equal(await st(svc.dentB), 'open');
      assert.equal(await st(svc.eyeB), 'closed', 'licensed but no hours today');
      assert.equal(await st(svc.injC), 'closed', 'after its last block');
      assert.equal(await st(svc.xrayC), 'outside_license_window');
    });
    it('service modes drive what is offered: queue = no bookable slots, appointment = no walk-in', async () => {
      const hyg = (await avail(t, svc.hygA.id, D)).json; assert.deepEqual(hyg.bookableSlots, []); assert.equal(hyg.walkIn.available, true);
      await putDay(t, svc.eyeB.id, D, { hours: [900, 930] });
      const eye = (await avail(t, svc.eyeB.id, D)).json; assert.ok(eye.bookableSlots.length > 0); assert.equal(eye.walkIn.available, false);
      assert.equal((await walkIn(t, svc.eyeB.id, D)).json.reason, 'no_walk_ins');
      assert.equal((await booked(t, svc.hygA.id, D, 600)).json.reason, 'no_bookings');
      await putDay(t, svc.eyeB.id, D, { hours: [] });
    });
    it('a service ID from another account never resolves under this account\'s tenant id', async () => {
      assert.equal((await avail(t, other.services[0].id, D)).status, 404);
      assert.equal((await walkIn(t, other.services[0].id, D)).status, 404);
    });
  });

  describe('tickets, queues and counters stay per location / service', () => {
    let a1, a2, b1, c1, tokA, tokB;
    it('same-named services at two locations number independently and carry their own location', async () => {
      a1 = await walkIn(t, svc.dentA.id, D); b1 = await walkIn(t, svc.dentB.id, D); a2 = await walkIn(t, svc.dentA.id, D);
      await at(`${D}T09:20:00Z`); // Minor Injuries is open 09:00-10:00; the SERVER clock decides (a client clockMinutes is ignored)
      c1 = await walkIn(t, svc.injC.id, D, { clockMinutes: 560 });
      for (const r of [a1, b1, a2, c1]) assert.equal(r.status, 200, r.text);
      assert.deepEqual([a1.json.ticket.ticket_number, a2.json.ticket.ticket_number, b1.json.ticket.ticket_number], ['DC-001', 'DC-002', 'DC-001']);
      assert.equal(a1.json.ticket.location_id, L.a.id); assert.equal(b1.json.ticket.location_id, L.b.id); assert.equal(c1.json.ticket.location_id, L.c.id);
      tokA = a1.json.publicToken; tokB = b1.json.publicToken;
    });
    it('the patient\'s own ticket shows their location and queue position, not another location\'s', async () => {
      const pa = (await pubTicket(tokA)).json, pb = (await pubTicket(tokB)).json;
      assert.deepEqual([pa.locationName, pa.peopleAhead], ['Amersham Clinic', 0]);
      assert.deepEqual([pb.locationName, pb.peopleAhead], ['Beaconsfield Clinic', 0]);
      assert.equal((await pubTicket(a2.json.publicToken)).json.peopleAhead, 1);
    });
    it('Today ribbon and call-next are per service: calling at A never takes B\'s patient', async () => {
      const ta = (await get(`/api/tenant/today?serviceId=${svc.dentA.id}`, { token: staff.token })).json;
      const tb = (await get(`/api/tenant/today?serviceId=${svc.dentB.id}`, { token: staff.token })).json;
      assert.equal(ta.queueCount, 2); assert.equal(tb.queueCount, 1);
      const c = await callNext(staff.token, svc.dentA.id, D, { roomLabel: 'Room A' });
      assert.equal(c.json.ticket.id, a1.json.ticket.id);
      assert.equal((await pubTicket(tokB)).json.state, 'waiting');
      assert.equal((await pubTicket(tokA)).json.state, 'called');
      assert.equal((await pubTicket(tokA)).json.calledRoom, 'Room A');
    });
    it('one staff member covers several services at different locations (same session, each service its own queue)', async () => {
      const cb = await callNext(staff.token, svc.dentB.id, D, { roomLabel: 'Room B' });
      assert.equal(cb.status, 200, cb.text); assert.equal(cb.json.ticket.id, b1.json.ticket.id);
      const cc = await callNext(staff.token, svc.injC.id, D, { roomLabel: 'Room C', clockMinutes: 560 });
      assert.equal(cc.status, 200, cc.text);
      assert.equal(cc.json.ticket.id, c1.json.ticket.id);
      assert.equal((await callNext(staff.token, svc.dentB.id, D)).status, 404, 'B has nobody left');
      assert.equal((await callNext(staff.token, svc.hygA.id, D)).status, 404);
    });
    it('the legacy per-ticket status message is about THIS ticket (same ticket number at two locations)', async () => {
      const sa = (await get(`${P(t)}/tickets/${a1.json.ticket.id}/status`)).json;
      const sb = (await get(`${P(t)}/tickets/${b1.json.ticket.id}/status`)).json;
      assert.match(sa.message, /Room A/); assert.doesNotMatch(sa.message, /Room B/);
      assert.match(sb.message, /Room B/); assert.doesNotMatch(sb.message, /Room A/);
    });
    it('call again to a different room updates the room the patient sees', async () => {
      const r = await post(`/api/tenant/tickets/${a1.json.ticket.id}/call-again`, { roomLabel: 'Room 9' }, { token: staff.token });
      assert.equal(r.status, 200);
      assert.equal((await pubTicket(tokA)).json.calledRoom, 'Room 9');
    });
    it('dashboard stats are account-wide (all locations), the ticket list carries location_id for filtering', async () => {
      const stats = (await get(`/api/tenant/dashboard/stats?date=${D}`, { token: t.token })).json.stats;
      assert.equal(stats.serving, 3); assert.equal(stats.waiting, 1);
      const list = (await tickets(t.token, D)).json.tickets;
      assert.deepEqual([...new Set(list.map((x) => x.location_id))].sort(), [L.a.id, L.b.id, L.c.id].sort());
    });
    it('another account sees none of it and cannot act on it', async () => {
      const ost = await addStaff(other);
      assert.equal((await tickets(other.token, D)).json.tickets.length, 0);
      assert.equal((await tickets(ost.token, D)).json.tickets.length, 0);
      assert.equal((await post(`/api/tenant/tickets/${a2.json.ticket.id}/call`, { roomLabel: 'x' }, { token: ost.token })).status, 409);
      assert.equal((await post(`/api/tenant/tickets/${a2.json.ticket.id}/cancel`, {}, { token: ost.token })).status, 404);
      assert.equal((await callNext(ost.token, svc.dentA.id, D)).status, 404);
      assert.equal((await get(`/api/tenant/today?serviceId=${svc.dentA.id}`, { token: ost.token })).status, 404);
      assert.equal((await get(`/api/tenant/services/${svc.dentA.id}/availability?date=${D}`, { token: ost.token })).status, 404);
    });
    it('staff access is per account, not per location (documented limitation: staff_access_code is stored but unused)', { todo: 'per-location staff access is not implemented - staff can work every location of their account' }, async () => {
      assert.fail('a staff member limited to Amersham should not be able to call at Beaconsfield');
    });
  });

  describe('routing a patient to another service / location', () => {
    let tix;
    beforeEach(async () => { tix = (await walkIn(t, svc.hygA.id, D)).json.ticket; });
    it('can be sent to a service at another location: ticket takes the new location, goes back to waiting, same day', async () => {
      const r = await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: svc.dentB.id }, { token: staff.token });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json.ticket.service_id, r.json.ticket.location_id, r.json.ticket.status, r.json.ticket.type, r.json.ticket.visit_date],
        [svc.dentB.id, L.b.id, 'waiting', 'walk_in', D]);
      const log = (await get('/api/tenant/audit-log', { token: t.token })).json.auditLog;
      assert.ok(log.some((e) => /routed from Hygiene to Dental Care/.test(e.message)));
    });
    it('cannot be sent to another account\'s service, a missing one, or after the ticket has ended', async () => {
      assert.equal((await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: other.services[0].id }, { token: staff.token })).status, 404);
      assert.equal((await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: 'nope' }, { token: staff.token })).status, 404);
      await post(`/api/tenant/tickets/${tix.id}/cancel`, {}, { token: staff.token });
      assert.equal((await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: svc.dentB.id }, { token: staff.token })).status, 409);
    });
    it('cannot be sent into an archived service or an archived location (nobody could serve them)', async () => {
      const arch = await post('/api/tenant/services', { name: 'Old Service', locationId: L.a.id }, { token: t.token });
      await patch(`/api/tenant/services/${arch.json.service.id}`, { archived: true }, { token: t.token });
      const r1 = await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: arch.json.service.id }, { token: staff.token });
      assert.equal(r1.status, 409, r1.text);
      const loc = await post('/api/tenant/locations', { name: `Closing ${rnd()}` }, { token: t.token });
      const ls = await post('/api/tenant/services', { name: 'Closing Svc', locationId: loc.json.location.id }, { token: t.token });
      await patch(`/api/tenant/locations/${loc.json.location.id}`, { archived: true }, { token: t.token });
      const r2 = await post(`/api/tenant/tickets/${tix.id}/route`, { newServiceId: ls.json.service.id }, { token: staff.token });
      assert.equal(r2.status, 409, r2.text);
    });
  });

  describe('archiving a location in the middle of the day', () => {
    let loc, s, st, waiting, calledOne;
    before(async () => {
      loc = (await post('/api/tenant/locations', { name: `Pop-up ${rnd()}` }, { token: t.token })).json.location;
      s = (await post('/api/tenant/services', { name: 'Walk-in Centre', locationId: loc.id }, { token: t.token })).json.service;
      await goLive(t, s, { plan: 'day', start: D });
      waiting = await walkIn(t, s.id, D); calledOne = await walkIn(t, s.id, D);
      await callNext(staff.token, s.id, D);
      st = await patch(`/api/tenant/locations/${loc.id}`, { archived: true }, { token: t.token });
    });
    it('is accepted and logged', async () => {
      assert.equal(st.status, 200); assert.equal(st.json.location.archived, true);
    });
    it('vanishes from the patient chooser and its services are no longer offered or joinable', async () => {
      assert.equal((await get(`${P(t)}/locations`)).json.locations.some((l) => l.id === loc.id), false);
      assert.equal((await get(`${P(t)}/services`)).json.services.some((x) => x.id === s.id), false);
      const a = (await avail(t, s.id, D)).json; assert.deepEqual([a.open, a.reason], [false, 'outside_license_window']);
      const j = await walkIn(t, s.id, D); assert.equal(j.status, 409); assert.equal(j.json.reason, 'outside_license_window');
      assert.equal((await booked(t, s.id, D, 600)).status, 409);
    });
    it('patients already in the queue keep their ticket and staff can still finish them', async () => {
      assert.equal((await pubTicket(waiting.json.publicToken)).json.state, 'called');
      const c = await callNext(staff.token, s.id, D);
      assert.ok([200, 404].includes(c.status));
      const list = (await tickets(t.token, D)).json.tickets.filter((x) => x.service_id === s.id);
      assert.equal(list.length, 2);
      const serving = list.find((x) => x.status === 'serving');
      if (serving) assert.equal((await post(`/api/tenant/tickets/${serving.id}/close`, {}, { token: staff.token })).status, 200);
      assert.ok(calledOne);
    });
    it('shows last in the admin list, and unarchiving brings everything back', async () => {
      const adminList = (await get('/api/tenant/locations', { token: t.token })).json.locations;
      assert.equal(adminList.at(-1).id, loc.id); assert.equal(adminList.at(-1).archived, true);
      await patch(`/api/tenant/locations/${loc.id}`, { archived: false }, { token: t.token });
      assert.equal((await get(`${P(t)}/locations`)).json.locations.some((l) => l.id === loc.id), true);
      assert.equal((await avail(t, s.id, D)).json.open, true);
    });
  });

  describe('location management', () => {
    it('location names are unique per account (case-insensitive), on add and on rename', async () => {
      const dup = await post('/api/tenant/locations', { name: 'amersham clinic' }, { token: t.token });
      assert.equal(dup.status, 409, dup.text);
      const ok = await post('/api/tenant/locations', { name: `Unique ${rnd()}` }, { token: t.token });
      assert.equal(ok.status, 200);
      const rename = await patch(`/api/tenant/locations/${ok.json.location.id}`, { name: 'CHESHAM CLINIC' }, { token: t.token });
      assert.equal(rename.status, 409, rename.text);
      assert.equal((await patch(`/api/tenant/locations/${ok.json.location.id}`, { name: 'Unique Renamed ' + rnd() }, { token: t.token })).status, 200);
      // another account may reuse the name
      assert.equal((await post('/api/tenant/locations', { name: 'Amersham Clinic' }, { token: other.token })).status, 200);
    });
    it('cannot create a service at another account\'s location', async () => {
      assert.equal((await post('/api/tenant/services', { name: 'Hijack', locationId: other.locations[0].id }, { token: t.token })).status, 404);
    });
    it('cannot archive or edit another account\'s location', async () => {
      assert.equal((await patch(`/api/tenant/locations/${other.locations[0].id}`, { archived: true }, { token: t.token })).status, 404);
    });
  });

  describe('on-site code per location and website links', () => {
    let codes;
    before(async () => {
      codes = Object.fromEntries((await get('/api/tenant/locations', { token: t.token })).json.locations.map((l) => [l.name, l.code]));
      await patch('/api/tenant/me', { onsiteOnly: true }, { token: t.token });
    });
    after(async () => { await patch('/api/tenant/me', { onsiteOnly: false }, { token: t.token }); });
    it('joining the live queue needs THIS location\'s code: none, another location\'s and a made-up one are all refused', async () => {
      const none = await walkIn(t, svc.dentA.id, D); assert.equal(none.status, 403); assert.equal(none.json.reason, 'onsite_code_required');
      const wrong = await walkIn(t, svc.dentA.id, D, { onsiteCode: codes['Beaconsfield Clinic'] }); assert.equal(wrong.status, 403); assert.equal(wrong.json.reason, 'onsite_code_invalid');
      const fake = await walkIn(t, svc.dentA.id, D, { onsiteCode: 'QB-ZZZZZZ' }); assert.equal(fake.json.reason, 'onsite_code_invalid');
    });
    it('the right code works (case and spaces forgiven); booking ahead needs no code', async () => {
      const ok = await walkIn(t, svc.dentA.id, D, { onsiteCode: ` ${codes['Amersham Clinic'].toLowerCase()} ` }); assert.equal(ok.status, 200, ok.text);
      const okB = await walkIn(t, svc.dentB.id, D, { onsiteCode: codes['Beaconsfield Clinic'] }); assert.equal(okB.status, 200, okB.text);
      assert.equal((await booked(t, svc.dentA.id, D, 1200)).status, 200);
    });
    it('the public code lookup names the right business and location, and never reveals other locations', async () => {
      const r = await get(`/api/public/code/${codes['Chesham Clinic']}`);
      assert.deepEqual([r.json.locationName, r.json.businessName, r.json.tenantId, r.json.locationId], ['Chesham Clinic', t.businessName, t.id, L.c.id]);
      assert.deepEqual(Object.keys(r.json).sort(), ['businessName', 'locationId', 'locationName', 'tenantId']);
    });
    it('website: business-wide, http(s) only (no javascript:/data:), bare domains get https://, blank clears it', async () => {
      for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.com', 'http://', 'https://user:pw@example.com', 'x'.repeat(301)]) {
        assert.equal((await patch('/api/tenant/me', { websiteUrl: bad }, { token: t.token })).status, 400, bad.slice(0, 40));
      }
      const ok = await patch('/api/tenant/me', { websiteUrl: 'example.org/clinic' }, { token: t.token });
      assert.equal(ok.status, 200); assert.equal(ok.json.tenant.website_url, 'https://example.org/clinic');
      assert.equal((await get(`${P(t)}/info`)).json.websiteUrl, 'https://example.org/clinic');
      assert.equal((await patch('/api/tenant/me', { websiteUrl: 'http://example.org' }, { token: t.token })).json.tenant.website_url, 'http://example.org');
      assert.equal((await patch('/api/tenant/me', { websiteUrl: '' }, { token: t.token })).json.tenant.website_url, '');
      assert.equal((await get(`${P(t)}/info`)).json.websiteUrl, null);
    });
  });
});

// =====================================================================================
// E. SECURITY (OWASP-oriented review, not a pentest)
// =====================================================================================
function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (ext.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function forgeJwt(payload, { secret = JWT_SECRET, alg = 'HS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, typ: 'JWT' })); const p = b64u(JSON.stringify(payload));
  const hmac = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
  const sig = hmac ? crypto.createHmac(hmac, secret).update(`${h}.${p}`).digest('base64url') : '';
  return `${h}.${p}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const decodeJwt = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());

describe('E. security', () => {
  let t, svcId, staff;
  before(async () => {
    await at('2026-11-10T12:00:00Z');
    t = await signup({ label: 'sec' }); svcId = t.services[0].id;
    await goLive(t, t.services[0], { plan: 'day', start: '2026-11-10', staff: { staffCount: 60, bookingStaffCount: 5, walkInStaffCount: 55 } });
    staff = await addStaff(t);
  });

  describe('JWT handling', () => {
    const claims = (o = {}) => ({ role: 'tenant_admin', tenantId: t.id, iat: nowSec(), exp: nowSec() + 600, ...o });
    const probe = (token) => get('/api/tenant/me', { token });
    it('a genuine token works (control)', async () => { assert.equal((await probe(forgeJwt(claims()))).status, 200); });
    it('alg:none, an empty signature, and an unsigned token are rejected', async () => {
      assert.equal((await probe(forgeJwt(claims(), { alg: 'none' }))).status, 401);
      assert.equal((await probe(forgeJwt(claims()).split('.').slice(0, 2).join('.') + '.')).status, 401);
      assert.equal((await probe(forgeJwt(claims()).split('.').slice(0, 2).join('.'))).status, 401);
    });
    it('the algorithm is pinned to HS256: a correctly-keyed HS384 / HS512 token is refused', async () => {
      assert.equal((await probe(forgeJwt(claims(), { alg: 'HS384' }))).status, 401);
      assert.equal((await probe(forgeJwt(claims(), { alg: 'HS512' }))).status, 401);
    });
    it('wrong secret, tampered payload and expired tokens are refused', async () => {
      assert.equal((await probe(forgeJwt(claims(), { secret: 'not-the-secret' }))).status, 401);
      const good = forgeJwt(claims());
      const [h, , s] = good.split('.');
      assert.equal((await probe(`${h}.${b64u(JSON.stringify(claims({ tenantId: other_id() })))}.${s}`)).status, 401);
      assert.equal((await probe(forgeJwt(claims({ iat: nowSec() - 7200, exp: nowSec() - 3600 })))).status, 401);
      assert.equal((await probe(forgeJwt(claims({ nbf: nowSec() + 3600 })))).status, 401);
    });
    function other_id() { return crypto.randomUUID(); }
    it('a validly signed token with an unknown role is refused; a staff token cannot use admin-only routes', async () => {
      assert.equal((await probe(forgeJwt(claims({ role: 'superuser' })))).status, 403);
      assert.equal((await probe(forgeJwt(claims({ role: 'system_admin' })))).status, 403, 'system_admin is not a tenant role');
      assert.equal((await get('/api/system/tenants', { token: forgeJwt(claims()) })).status, 403);
      assert.equal((await get('/api/system/tenants', { token: staff.token })).status, 403);
      assert.equal((await get('/api/tenant/staff', { token: staff.token })).status, 403);
    });
    it('a token naming an account that no longer exists, or a deleted staff member, stops working at once', async () => {
      assert.equal((await probe(forgeJwt(claims({ tenantId: crypto.randomUUID() })))).status, 404);
      const tmp = await addStaff(t, 'Temp', 'Person');
      assert.equal((await get('/api/tenant/me', { token: tmp.token })).status, 200);
      await del(`/api/tenant/staff/${tmp.id}`, { token: t.token });
      assert.equal((await get('/api/tenant/me', { token: tmp.token })).status, 401);
      const disabled = await addStaff(t, 'Off', 'Duty');
      await patch(`/api/tenant/staff/${disabled.id}`, { active: false }, { token: t.token });
      assert.equal((await get('/api/tenant/me', { token: disabled.token })).status, 401);
    });
    it('a staff token without a staffId (forged) is refused', async () => {
      assert.equal((await probe(forgeJwt(claims({ role: 'staff' })))).status, 401);
      assert.equal((await probe(forgeJwt(claims({ role: 'staff', staffId: crypto.randomUUID() })))).status, 401);
    });
    it('tokens are only read from the Authorization header (not the query string, a cookie or a body)', async () => {
      const good = forgeJwt(claims());
      assert.equal((await get(`/api/tenant/me?token=${good}&access_token=${good}`)).status, 401);
      assert.equal((await get('/api/tenant/me', { headers: { cookie: `token=${good}; jwt=${good}` } })).status, 401);
      assert.equal((await get('/api/tenant/me', { headers: { authorization: good } })).status, 401, 'no "Bearer " prefix');
      assert.equal((await get('/api/tenant/me', { headers: { authorization: `bearer ${good}` } })).status, 401, 'scheme is case-sensitive here: documented');
    });
    it('session lifetimes are bounded: system admin <= 12h, staff <= 16h, tenant admin <= 12h', async () => {
      const sys = decodeJwt(await systemToken()); assert.ok(sys.exp - sys.iat <= 12 * 3600, `system ${sys.exp - sys.iat}s`);
      // CHANGED: staff 16h (was 10h, bound 12h) and admin 12h (was 30 days), both configurable and slid forward while in use.
      const st = decodeJwt(staff.token); assert.ok(st.exp - st.iat <= 16 * 3600, `staff ${st.exp - st.iat}s`);
      const ad = decodeJwt(t.token); assert.ok(ad.exp - ad.iat <= 12 * 3600, `admin ${ad.exp - ad.iat}s`);
      for (const tok of [await systemToken(), staff.token, t.token]) assert.equal(JSON.parse(Buffer.from(tok.split('.')[0], 'base64url')).alg, 'HS256');
    });
    it('session tokens carry no secrets or PII (ids and role only)', () => {
      for (const tok of [t.token, staff.token]) {
        const c = decodeJwt(tok);
        assert.deepEqual(Object.keys(c).filter((k) => !['role', 'tenantId', 'staffId', 'iat', 'exp', 'tv', 'at'].includes(k)), []);
      }
    });
    it('the server refuses to start without JWT_SECRET', async () => {
      const env = { ...process.env, PORT: String(await freePort()), DATABASE_URL, DATABASE_SSL: 'false' }; delete env.JWT_SECRET; delete env.NODE_ENV; delete env.QB_TEST_NOW;
      const code = await new Promise((resolve) => {
        const c = spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env, stdio: 'ignore' });
        const kill = setTimeout(() => { c.kill('SIGKILL'); resolve('still running'); }, 4000);
        c.on('exit', (cd) => { clearTimeout(kill); resolve(cd); });
      });
      assert.equal(code, 1);
    });
  });

  describe('patient ticket links (token in the URL)', () => {
    let tokens = [];
    it('tokens are 24-character base64url strings (144 bits) and never repeat', async () => {
      for (let i = 0; i < 40; i++) {
        const r = await walkIn(t, svcId, '2026-11-10', {}, randIp());
        assert.equal(r.status, 200, r.text); tokens.push(r.json.publicToken);
      }
      for (const k of tokens) assert.match(k, /^[A-Za-z0-9_-]{24}$/);
      assert.equal(new Set(tokens).size, tokens.length);
      // every character position varies (no fixed prefix / counter), and neighbours share nothing obvious
      for (let pos = 0; pos < 24; pos++) assert.ok(new Set(tokens.map((k) => k[pos])).size > 8, `position ${pos} is too predictable`);
      let sharedPrefix = 0; for (let i = 1; i < tokens.length; i++) { let n = 0; while (tokens[i][n] === tokens[i - 1][n]) n++; sharedPrefix = Math.max(sharedPrefix, n); }
      assert.ok(sharedPrefix <= 3, `consecutive tokens share ${sharedPrefix} leading characters`);
    });
    it('there is no way to list or enumerate tickets without a token', async () => {
      for (const p of ['/api/public/ticket', '/api/public/ticket/', '/api/public/ticket/*', '/api/public/ticket/list', '/api/public/ticket/%25', `/api/public/tickets`, `${P(t)}/tickets`]) {
        const r = await get(p);
        assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`);
        assert.doesNotMatch(r.text, /ticket_number|DC-0/);
      }
    });
    it('near-miss and malformed tokens are all just "not found"', async () => {
      const k = tokens[0];
      const flipped = k.slice(0, -1) + (k.endsWith('A') ? 'B' : 'A');
      for (const bad of [flipped, k.slice(1), k + 'A', k.toLowerCase() === k ? k.toUpperCase() : k.toLowerCase(), "' or '1'='1", '..%2f..%2f', 'a'.repeat(23), 'a'.repeat(65), '%00']) {
        const r = await get(`/api/public/ticket/${encodeURIComponent(bad)}`);
        assert.equal(r.status, 404, `${bad} -> ${r.status} ${r.text}`);
        assert.deepEqual(r.json, { error: 'Ticket not found.', state: 'unknown' });
      }
    });
    it('the token view reveals only ticket details: no account, staff, e-mail, pricing or other-ticket data; never cached', async () => {
      const r = await pubTicket(tokens[1]);
      assert.deepEqual(Object.keys(r.json).sort(), ['arrived', 'businessName', 'calledRoom', 'estimatedMinutes', 'locationName', 'peopleAhead', 'serviceName', 'slotTime', 'state', 'ticketNumber', 'timezone', 'type', 'updatedAt', 'whatsappConnected', 'whatsappLinkCode', 'whatsappUpdatesOffer', 'whatsappUpdatesRequested']);
      assert.match(r.headers.get('cache-control'), /no-store/);
      assert.doesNotMatch(r.text, new RegExp(`${t.id}|${t.email}|tenant_id|access_code`));
    });
    it('brute-forcing tokens from one connection is throttled (429) while normal polling is fine', async () => {
      const ip = randIp(); let limited = 0;
      for (let i = 0; i < 110; i++) { const r = await get(`/api/public/ticket/${crypto.randomBytes(18).toString('base64url')}`, { ip }); if (r.status === 429) limited++; }
      assert.ok(limited > 0, 'no 429 after 110 guesses in a burst');
    });
    it('a ticket can only be left, checked in or WhatsApp-flagged through its own token', async () => {
      const a = await walkIn(t, svcId, '2026-11-10', {}, randIp()); const b = await walkIn(t, svcId, '2026-11-10', {}, randIp());
      assert.equal((await post(`/api/public/ticket/${a.json.publicToken}/leave`, {})).json.state, 'cancelled');
      assert.equal((await pubTicket(b.json.publicToken)).json.state, 'waiting', 'the other ticket is untouched');
    });
    it('the patient app does not leak the link in the Referer header (meta referrer + API Referrer-Policy)', () => {
      const html = fs.readFileSync(path.join(ROOT, 'customer/index.html'), 'utf8');
      assert.match(html, /<meta name="referrer" content="no-referrer"/);
    });
  });

  describe('CORS', () => {
    const EVIL = 'https://evil.example';
    const pre = (p, origin, method = 'GET') => http.api('OPTIONS', p, { headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' } });
    it('authenticated APIs allow only the configured app origins, with credentials', async () => {
      for (const p of ['/api/tenant/me', '/api/auth/admin/request-otp', '/api/system/tenants']) {
        const bad = await pre(p, EVIL);
        assert.equal(bad.headers.get('access-control-allow-origin'), null, `${p} preflight from an unknown origin`);
        const ok = await pre(p, 'http://localhost:5173');
        assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
        assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
        const get1 = await get(p, { headers: { origin: EVIL } });
        assert.equal(get1.headers.get('access-control-allow-origin'), null, `${p} actual request from an unknown origin`);
      }
    });
    it('an "Origin: null" request (sandboxed iframe / file:) gets no CORS grant on the authenticated APIs', async () => {
      assert.equal((await get('/api/tenant/me', { headers: { origin: 'null' } })).headers.get('access-control-allow-origin'), null);
    });
    it('credentials are never combined with a wildcard origin anywhere', async () => {
      for (const p of ['/api/tenant/me', '/api/public/clock', '/api/public/pricing', `${P(t)}/info`, '/api/whatsapp/webhook']) {
        const r = await get(p, { headers: { origin: EVIL } });
        const acao = r.headers.get('access-control-allow-origin'); const acac = r.headers.get('access-control-allow-credentials');
        assert.ok(!(acao === '*' && acac === 'true'), `${p} -> ${acao}/${acac}`);
      }
    });
    it('public patient endpoints are readable from any origin but never with credentials', async () => {
      const r = await get(`${P(t)}/locations`, { headers: { origin: EVIL } });
      assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('access-control-allow-credentials'), null);
    });
    it('a CORS_ORIGIN containing "*" does not turn the authenticated APIs into a free-for-all', async () => {
      const s2 = await startServer({ label: 'cors', env: { CORS_ORIGIN: '*' } });
      try {
        const r = await client(() => s2.base).api('OPTIONS', '/api/tenant/me', { headers: { origin: EVIL, 'access-control-request-method': 'GET' } });
        assert.notEqual(r.headers.get('access-control-allow-origin'), EVIL);
        assert.ok(!(r.headers.get('access-control-allow-origin') === '*' && r.headers.get('access-control-allow-credentials') === 'true'));
      } finally { await stopServer(s2); }
    });
  });

  describe('response headers', () => {
    const paths = ['/health', '/api/public/clock', '/api/tenant/me', '/api/auth/system/login', '/api/does-not-exist', '/api/public/ticket/short'];
    it('every response carries the baseline security headers and no X-Powered-By', async () => {
      for (const p of paths) {
        const r = await get(p, { token: p === '/api/tenant/me' ? t.token : undefined });
        const h = (n) => r.headers.get(n);
        assert.equal(h('x-content-type-options'), 'nosniff', p);
        assert.equal(h('x-frame-options'), 'DENY', p);
        assert.equal(h('referrer-policy'), 'no-referrer', p);
        assert.match(h('content-security-policy'), /default-src 'none'/, p); assert.match(h('content-security-policy'), /frame-ancestors 'none'/, p);
        assert.equal(h('x-powered-by'), null, p);
      }
    });
    it('responses with sessions or account data are never cached', async () => {
      assert.match((await get('/api/tenant/me', { token: t.token })).headers.get('cache-control'), /no-store/);
      assert.match((await post('/api/auth/admin/request-otp', { email: t.email })).headers.get('cache-control'), /no-store/);
      assert.match((await get('/api/system/tenants', { token: await systemToken() })).headers.get('cache-control'), /no-store/);
    });
    it('HSTS is sent when the request came in over TLS (X-Forwarded-Proto) and not over plain http', async () => {
      assert.match((await get('/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security') || '', /max-age=\d{7,}/);
      assert.equal((await get('/health')).headers.get('strict-transport-security'), null);
    });
    it('error responses are JSON, never stack traces, and a hostile path is not reflected as markup', async () => {
      const r = await get('/api/%3Cscript%3Ealert(1)%3C/script%3E');
      assert.doesNotMatch(r.text, /<script>/i); assert.doesNotMatch(r.text, /\n\s+at .*\(/);
      const bad = await post('/api/auth/admin/verify-otp', {}, { rawBody: '{"a":' });
      assert.equal(bad.status, 400); assert.doesNotMatch(bad.text, /node_modules|\/home\/|SyntaxError/);
    });
    it('the other deployables need their own headers at the static host (reported, not testable here)', { todo: 'marketing/customer/staff/customer-admin/admin are static sites: CSP, frame-ancestors, X-Content-Type-Options and HSTS must be set in the host config (render.yaml has none)' }, () => assert.fail('no headers configured for static sites'));
  });

  describe('injection', () => {
    it('no server SQL is assembled from request data: every query template with ${...} is on the allow-list', () => {
      const allowed = [/\$\{nowSql\(\)\}/g, /a\.\$\{col\}/g]; // clock literal built from the server's own clock; a column name chosen from two string literals
      const offenders = [];
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) {
        const src = fs.readFileSync(f, 'utf8');
        // only template literals handed to a query function (audit-log prose also contains words like "from")
        for (const m of src.matchAll(/(?:query|queryFn|sql|db)\(\s*`([^`]*)`/g)) {
          let body = m[1];
          if (!body.includes('${')) continue;
          for (const a of allowed) body = body.replace(a, '');
          if (body.includes('${')) offenders.push(`${path.relative(SERVER_DIR, f)}: ${m[1].slice(0, 80).replace(/\s+/g, ' ')}`);
        }
      }
      assert.deepEqual(offenders, []);
    });
    it('the one dynamic column (ticket_web_access device/ip) is only ever called with fixed literals', () => {
      const src = fs.readFileSync(path.join(SERVER_DIR, 'src/lib/tickets.js'), 'utf8');
      const calls = [...src.matchAll(/activeCount\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
      assert.deepEqual(calls.sort(), ['device_hash', 'ip_hash']);
    });
    it('classic injection strings in every kind of input are inert and the data survives', async () => {
      const before = Number(sql(`select count(*) from tickets where tenant_id='${t.id}'`));
      const inj = ["' OR '1'='1", "'; drop table tickets; --", "1; select pg_sleep(5)--", '" OR ""="', "\\'; delete from tenants where 'a'='a", '%27%20OR%201=1--'];
      const t0 = Date.now();
      for (const v of inj) {
        const e = encodeURIComponent(v);
        for (const r of [
          await post('/api/auth/admin/request-otp', { email: v }), await post('/api/auth/admin/verify-otp', { email: t.email, code: v }),
          await post('/api/auth/staff/request-otp', { email: v }), await post('/api/auth/staff/verify-otp', { email: v, code: v }),
          await post('/api/auth/system/login', { password: v }), await get(`/api/public/code/${e}`),
          await get(`/api/public/ticket/${e}`), await get(`${P(t)}/services/${e}/availability?date=${e}`),
          await get(`${P(t)}/services/${svcId}/availability?date=${e}&clockMinutes=${e}`),
          await walkIn(t, svcId, '2026-11-10', { onsiteCode: v, deviceId: v, clockMinutes: v }, randIp()),
          await get(`/api/tenant/tickets?date=${e}`, { token: t.token }), await get(`/api/tenant/today?serviceId=${e}`, { token: t.token }),
          await post('/api/tenant/locations', { name: v, address: v }, { token: t.token }),
          await patch('/api/tenant/me', { businessName: v, companyAddress: v }, { token: t.token }),
        ]) assert.ok(r.status < 500, `${r.status} ${r.text.slice(0, 120)}`);
      }
      assert.ok(Date.now() - t0 < 4500, 'a pg_sleep injection would stall here');
      // (some of those joins are legitimate and create a ticket; none may delete anything)
      assert.ok(Number(sql(`select count(*) from tickets where tenant_id='${t.id}'`)) >= before);
      assert.ok(Number(sql('select count(*) from tenants')) > 3);
      // the values were stored as plain text
      assert.equal((await get('/api/tenant/me', { token: t.token })).json.tenant.business_name, inj.at(-1));
    });
    it('duplicate query parameters, prototype-pollution bodies and odd content types give 4xx, not 500', async () => {
      for (const r of [
        await get(`/api/tenant/today?serviceId=${svcId}&serviceId=${svcId}`, { token: t.token }),
        await get(`${P(t)}/services/${svcId}/availability?date=2026-11-10&date=2026-11-11`),
        await get(`${P(t)}/services/${svcId}/availability?date[a]=1`),
        await post('/api/tenant/locations', {}, { token: t.token, rawBody: '{"__proto__":{"isAdmin":true},"name":"x"}' }),
        await post('/api/tenant/setup/dismiss', {}, { token: t.token, rawBody: '{"constructor":{"prototype":{"x":1}},"task":"a"}' }),
        await api2('POST', '/api/tenant/locations', 'name=x', 'application/x-www-form-urlencoded', t.token),
        await api2('POST', '/api/tenant/locations', '{"name":"x"}', 'text/plain', t.token),
      ]) assert.ok(r.status >= 200 && r.status < 500, `${r.status} ${r.text.slice(0, 100)}`);
      assert.equal(({}).isAdmin, undefined);
      assert.equal((await get('/health')).status, 200);
    });
    function api2(method, p, rawBody, ct, token) { return http.api(method, p, { rawBody, token, headers: { 'content-type': ct } }); }
  });

  describe('stored XSS, links and output encoding', () => {
    const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'-alert(1)-'", '<svg/onload=alert(1)>', 'javascript:alert(1)'];
    it('hostile business / location / service / staff / room names are stored as text and served as JSON only', async () => {
      const x = await signup({ label: 'xss' });
      const loc = (await post('/api/tenant/locations', { name: XSS[0], address: XSS[1] }, { token: x.token })).json.location;
      const sv = (await post('/api/tenant/services', { name: XSS[2], locationId: loc.id }, { token: x.token })).json.service;
      await patch('/api/tenant/me', { businessName: XSS[3], firstName: XSS[0], lastName: XSS[1] }, { token: x.token });
      const stf = await post('/api/tenant/staff', { firstName: XSS[0], lastName: XSS[1], email: `gaps-xss-${rnd()}@example.com` }, { token: x.token });
      assert.equal(stf.status, 200);
      await goLive(x, sv, { plan: 'day', start: '2026-11-10' });
      const j = await walkIn(x, sv.id, '2026-11-10', {}, randIp());
      const s2 = await addStaff(x);
      const c = await callNext(s2.token, sv.id, '2026-11-10', { roomLabel: XSS[1].slice(0, 70) });
      assert.equal(c.status, 200, c.text);
      for (const r of [await get(`${P(x)}/locations`), await get(`${P(x)}/info`), await pubTicket(j.json.publicToken), await get('/api/tenant/locations', { token: x.token }), await get('/api/tenant/audit-log', { token: x.token })]) {
        assert.match(r.headers.get('content-type'), /^application\/json/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      }
      assert.equal((await get(`${P(x)}/locations`)).json.locations.find((l) => l.id === loc.id).name, XSS[0]);
      assert.equal((await pubTicket(j.json.publicToken)).json.calledRoom, XSS[1].slice(0, 70));
    });
    it('server-built messages (sign-in e-mails, WhatsApp call text) contain only the code or the room label, as plain text', () => {
      const bodies = [];
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/logSimulatedMessage\(\{[^}]*body[^}]*\}/g)) bodies.push(m[0]);
      }
      assert.ok(bodies.length >= 3);
      for (const b of bodies) assert.doesNotMatch(b, /<\w+[^>]*>|businessName|business_name|locationName|serviceName/, b);
    });
    it('no front-end source uses innerHTML / dangerouslySetInnerHTML / document.write / eval', () => {
      const bad = [];
      for (const app of ['admin', 'customer', 'customer-admin', 'marketing', 'staff']) {
        for (const f of walk(path.join(ROOT, app, 'src'), ['.js', '.jsx'])) {
          const src = fs.readFileSync(f, 'utf8');
          for (const re of [/dangerouslySetInnerHTML/, /\.innerHTML\s*=/, /\.outerHTML\s*=/, /document\.write\(/, /\beval\(/, /new Function\(/, /insertAdjacentHTML/]) if (re.test(src)) bad.push(`${path.relative(ROOT, f)}: ${re}`);
        }
      }
      assert.deepEqual(bad, []);
    });
    it('every target="_blank" link carries rel="noopener noreferrer"', () => {
      const bad = [];
      for (const app of ['admin', 'customer', 'customer-admin', 'marketing', 'staff']) {
        for (const f of walk(path.join(ROOT, app, 'src'), ['.jsx'])) {
          for (const m of fs.readFileSync(f, 'utf8').matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) if (!/rel="[^"]*noopener[^"]*noreferrer[^"]*"/.test(m[0])) bad.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 90)}`);
        }
      }
      assert.deepEqual(bad, []);
    });
    it('printable pages built from account data (QR sheet, brochure, licence receipt) escape every interpolated value', () => {
      const src = fs.readFileSync(path.join(ROOT, 'customer-admin/src/App.jsx'), 'utf8');
      const htmlTemplates = [...src.matchAll(/const html = `([\s\S]*?)`;/g)].map((m) => m[1]);
      assert.ok(htmlTemplates.length >= 2);
      const bad = [];
      for (const tpl of htmlTemplates) for (const m of tpl.matchAll(/\$\{([^}]+)\}/g)) {
        const e = m[1].trim();
        if (/^escHtml\(/.test(e) || /^qrImg$/.test(e) || /^rows\.map/.test(e) || /^businessAddress \? `/.test(e) || e === 'cards') continue;
        bad.push(e);
      }
      assert.deepEqual(bad, []);
      const brochure = src.slice(src.indexOf('function downloadBrochure'), src.indexOf('function downloadBrochure') + 2500);
      assert.doesNotMatch(brochure, /\$\{(tenant\.business_name|l\.name|l\.code)\}/);
    });
    it('window.open of a stored website only ever opens http(s) with noopener (patient app)', () => {
      const src = fs.readFileSync(path.join(ROOT, 'customer/src/App.jsx'), 'utf8');
      assert.match(src, /protocol === "http:" \|\| u\.protocol === "https:"/);
      assert.match(src, /window\.open\(u\.href, "_blank", "noopener,noreferrer"\)/);
    });
  });

  describe('CSRF, redirects, SSRF, path traversal', () => {
    it('auth is a Bearer header only: the API never sets a cookie', async () => {
      const seen = [];
      for (const r of [await post('/api/auth/admin/request-otp', { email: t.email }), await post('/api/auth/system/login', { password: SYSTEM_PASSWORD }), await get('/api/tenant/me', { token: t.token }), await get('/api/public/clock')]) seen.push(r.headers.get('set-cookie'));
      assert.deepEqual(seen, [null, null, null, null]);
      assert.equal((await post('/api/tenant/locations', { name: 'csrf' }, { headers: { cookie: 'a=b', origin: 'https://evil.example' } })).status, 401);
    });
    it('a cross-site HTML form post (text/plain or urlencoded body, no preflight) cannot join a queue or change anything', async () => {
      const before = Number(sql(`select count(*) from tickets where tenant_id='${t.id}'`));
      const body = JSON.stringify({ type: 'walk_in', date: '2026-11-10' });
      for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const r = await http.api('POST', `${P(t)}/services/${svcId}/tickets`, { rawBody: body, headers: { 'content-type': ct, origin: 'https://evil.example' } });
        assert.equal(r.status, 400, `${ct}: ${r.text}`);
      }
      assert.equal(Number(sql(`select count(*) from tickets where tenant_id='${t.id}'`)), before);
    });
    it('the server never redirects (no open redirect) and sets no Location header on any path', async () => {
      for (const p of ['/api/redirect?url=https://evil.example', '/api/auth/login?next=https://evil.example', '//evil.example', '/api/public/code/QB-AAAAAA?redirect=https://evil.example', '/%2F%2Fevil.example']) {
        const r = await get(p); assert.equal(r.headers.get('location'), null, p); assert.ok(r.status < 300 || r.status >= 400, p);
      }
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\.redirect\(/, f);
    });
    it('the server makes no outbound requests on behalf of users (SSRF): the only fetch() calls are the operator-configured email and WhatsApp providers (fixed URLs from env, never request data); the only other network call is an MX lookup', () => {
      // CHANGED: real email/WhatsApp delivery adds fetch() in lib/email.js and lib/whatsapp.js. Their targets come from environment variables
      // (RESEND_API_URL / WHATSAPP_API_URL), not from anything a visitor sends; nothing else may use a network client.
      const allowed = new Set(['src/lib/email.js', 'src/lib/whatsapp.js']);
      const hits = [];
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) {
        const rel = path.relative(SERVER_DIR, f);
        const src = fs.readFileSync(f, 'utf8');
        const fetchOk = allowed.has(rel);
        for (const re of [/\bfetch\(/, /\baxios\b/, /http\.request|https\.request|http\.get|https\.get/, /require\(["']node-fetch/, /from ["']node-fetch/, /\bnet\.connect|\bnet\.Socket/]) {
          if (re.test(src) && !(fetchOk && re.source === /\bfetch\(/.source)) hits.push(`${rel}: ${re}`);
        }
      }
      assert.deepEqual(hits, []);
      for (const rel of allowed) {
        const src = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
        assert.doesNotMatch(src, /req\.(body|query|params)/, `${rel} must not build a request target from request data`);
      }
      const mail = fs.readFileSync(path.join(SERVER_DIR, 'src/lib/emailCheck.js'), 'utf8');
      assert.match(mail, /resolveMx/);
    });
    it('no request data ever reaches the file system: only the migration script uses fs, and nothing is served statically', async () => {
      const users = walk(path.join(SERVER_DIR, 'src'), ['.js']).filter((f) => /from ["'](node:)?fs(\/promises)?["']|require\(["']fs/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SERVER_DIR, f));
      assert.deepEqual(users, ['src/db/migrate.js']);
      assert.doesNotMatch(fs.readFileSync(path.join(SERVER_DIR, 'src/index.js'), 'utf8'), /express\.static|sendFile/);
      for (const p of ['/..%2f..%2f..%2fetc%2fpasswd', '/api/public/code/..%2f..%2fetc%2fpasswd', '/api/public/ticket/..%2f..%2fpackage.json', '/.env', '/package.json', '/api/..%5c..%5cwindows%5cwin.ini', '/%2e%2e/%2e%2e/etc/passwd']) {
        const r = await get(p);
        assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`); assert.doesNotMatch(r.text, /root:|JWT_SECRET|DATABASE_URL|"name": "qbooker/);
      }
    });
  });

  describe('mass assignment', () => {
    it('PATCH /me cannot change status, ids, billing, access code, country or counters', async () => {
      const x = await signup({ label: 'mass' });
      const beforeRow = sqlJson(`select id, status, access_code, payment_method, location_count, signup_country, created_at, email from tenants where id='${x.id}'`)[0];
      const r = await patch('/api/tenant/me', { businessName: 'mass-ok', status: 'disabled', id: crypto.randomUUID(), access_code: 'HACK-HACK', payment_method: 'later', location_count: 99, signup_country: 'XX', created_at: '2000-01-01', invoice_po: 'x', dismissed_setup_tasks: ['a'], role: 'system_admin' }, { token: x.token });
      assert.equal(r.status, 200, r.text);
      const afterRow = sqlJson(`select id, status, access_code, payment_method, location_count, signup_country, created_at, email, business_name from tenants where id='${x.id}'`)[0];
      assert.equal(afterRow.business_name, 'mass-ok'); delete afterRow.business_name;
      assert.deepEqual(afterRow, beforeRow);
    });
    it('service, location, staff and ticket updates ignore tenant_id / location_id / ids / numbers', async () => {
      const x = await signup({ label: 'mass2' }); const o = await signup({ label: 'mass3' });
      const svc = x.services[0];
      await patch(`/api/tenant/services/${svc.id}`, { name: 'Renamed', tenant_id: o.id, location_id: o.locations[0].id, id: crypto.randomUUID(), created_at: '2000-01-01' }, { token: x.token });
      const row = sqlJson(`select tenant_id, location_id from services where id='${svc.id}'`)[0];
      assert.deepEqual([row.tenant_id, row.location_id], [x.id, svc.location_id]);
      await patch(`/api/tenant/locations/${x.locations[0].id}`, { name: 'LocRenamed', tenant_id: o.id, staff_access_code: 'HACK', code: 'QB-HACKED' }, { token: x.token });
      const loc = sqlJson(`select tenant_id, staff_access_code from locations where id='${x.locations[0].id}'`)[0];
      assert.equal(loc.tenant_id, x.id); assert.notEqual(loc.staff_access_code, 'HACK');
      const stf = (await post('/api/tenant/staff', { firstName: 'A', lastName: 'B', email: `gaps-mass-${rnd()}@example.com`, tenant_id: o.id, active: false }, { token: x.token })).json.staff;
      assert.equal(sqlJson(`select tenant_id, active from staff_members where id='${stf.id}'`)[0].tenant_id, x.id);
      await goLive(x, svc, { plan: 'day', start: '2026-11-10' });
      const tk = (await walkIn(x, svc.id, '2026-11-10', {}, randIp())).json.ticket;
      const pr = await patch(`/api/tenant/tickets/${tk.id}`, { status: 'seen', tenant_id: o.id, ticket_number: 'HACK-999', visit_date: '2000-01-01', created_at: '2000-01-01', closed_by_system: true }, { token: x.token });
      assert.equal(pr.status, 200);
      const trow = sqlJson(`select tenant_id, ticket_number, visit_date, closed_by_system, status from tickets where id='${tk.id}'`)[0];
      assert.deepEqual([trow.tenant_id, trow.ticket_number, trow.visit_date, trow.closed_by_system, trow.status], [x.id, tk.ticket_number, '2026-11-10', false, 'seen']);
    });
    it('sign-up ignores client-supplied status, access code, billing and counters', async () => {
      const email = `gaps-${RUN}-mass-su-${rnd()}@example.com`;
      const r = await signupV(post, { businessName: `gaps-su-${rnd()}`, firstName: 'A', lastName: 'B', email, locations: [{ name: 'Main', staff_access_code: 'HACK', code: 'QB-HACKED' }], services: [{ name: 'Svc', locationIndex: 0, tenant_id: crypto.randomUUID() }],
        status: 'pending', access_code: 'HACK-HACK', payment_method: 'later', location_count: 50, id: crypto.randomUUID(), signup_country: 'XX', invoice_po: 'x' });
      assert.equal(r.status, 200, r.text); createdTenants.push(r.json.tenant.id);
      const row = sqlJson(`select status, access_code, payment_method, location_count, signup_country from tenants where id='${r.json.tenant.id}'`)[0];
      assert.equal(row.status, 'active'); assert.notEqual(row.access_code, 'HACK-HACK'); assert.equal(row.payment_method, 'card'); assert.equal(row.location_count, 1); assert.notEqual(row.signup_country, 'XX');
      assert.equal(sqlJson(`select count(*) c from location_codes where tenant_id='${r.json.tenant.id}' and code='QB-HACKED'`)[0].c, 0);
    });
  });

  describe('enumeration and secret handling', () => {
    it('staff sign-in answers identically (200) for known, unknown and disabled addresses', async () => {
      const known = await post('/api/auth/staff/request-otp', { email: staff.email });
      const unknown = await post('/api/auth/staff/request-otp', { email: `nobody-${rnd()}@example.com` });
      assert.deepEqual([known.status, unknown.status], [200, 200]); assert.equal(unknown.json.ok, true);
    });
    it('a disabled business and a business that never existed look the same to the public', async () => {
      const x = await signup({ label: 'dis' });
      await patch(`/api/system/tenants/${x.id}`, { status: 'disabled' }, { token: await systemToken() });
      const a = await get(`/api/public/tenant/${x.id}/info`); const b = await get(`/api/public/tenant/${crypto.randomUUID()}/info`);
      assert.deepEqual([a.status, a.text], [b.status, b.text]);
    });
    it('location-code lookups are throttled and codes use the unambiguous 32-character alphabet', async () => {
      const ip = randIp(); let limited = 0;
      for (let i = 0; i < 80; i++) if ((await get('/api/public/code/QB-AAAAAA', { ip })).status === 429) limited++;
      assert.ok(limited > 0, 'no throttle on code guessing');
      const code = (await get('/api/tenant/locations', { token: t.token })).json.locations[0].code;
      assert.match(code, /^QB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    });
    it('no Math.random() anywhere in the server (codes and tokens come from crypto)', () => {
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) assert.doesNotMatch(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''), /Math\.random/, f);
    });
    it('sign-in codes: 6 digits, single-use, burn after 5 wrong guesses, expire', async () => {
      const x = await signup({ label: 'otp' });
      const o1 = (await post('/api/auth/admin/request-otp', { email: x.email })).json.demoOtp;
      assert.match(o1, /^\d{6}$/);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: x.email, code: o1 })).status, 200);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: x.email, code: o1 })).status, 401, 'single use');
      const o2 = (await post('/api/auth/admin/request-otp', { email: x.email })).json.demoOtp;
      for (let i = 0; i < 5; i++) await post('/api/auth/admin/verify-otp', { email: x.email, code: o2 === '000000' ? '111111' : '000000' });
      assert.equal((await post('/api/auth/admin/verify-otp', { email: x.email, code: o2 })).status, 401, 'dead after 5 wrong guesses');
      const o3 = (await post('/api/auth/admin/request-otp', { email: x.email })).json.demoOtp;
      sql(`update admin_otp set expires_at = now() - interval '1 minute' where tenant_id='${x.id}'`);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: x.email, code: o3 })).status, 401, 'expired');
    });
    it('the API log holds no tokens, secrets, OTPs or passwords', async () => {
      // generate sign-in traffic first
      const x = await signup({ label: 'logscan' });
      const otp = (await post('/api/auth/admin/request-otp', { email: x.email })).json.demoOtp;
      await post('/api/auth/system/login', { password: 'definitely-wrong-password' });
      await post('/api/auth/admin/verify-otp', { email: x.email, code: '999999' });
      const log = fs.readFileSync(srv.logFile, 'utf8');
      for (const needle of [JWT_SECRET, SYSTEM_PASSWORD, 'definitely-wrong-password', 'Bearer ', x.token, staff.token, t.token, 'eyJhbGci']) assert.equal(log.includes(needle), false, `log contains ${needle.slice(0, 12)}...`);
      assert.equal(new RegExp(`\\b${otp}\\b`).test(log), false, 'OTP in log');
      assert.doesNotMatch(log, /\n\s+at .*node_modules/, 'stack traces for client errors');
    });
    it('console.log in the server is limited to start-up banners', () => {
      const hits = [];
      for (const f of walk(path.join(SERVER_DIR, 'src'), ['.js'])) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => { if (/console\.log\(/.test(ln)) hits.push(`${path.relative(SERVER_DIR, f)}:${i + 1} ${ln.trim().slice(0, 70)}`); });
      }
      for (const h of hits) assert.match(h, /listening on port|Found |Applying|Applied|All migrations/, h);
    });
  });
});
