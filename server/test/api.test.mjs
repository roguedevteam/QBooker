// QBooker API test suite.  Run:  node --test server/test/api.test.mjs
//
// Env:  BASE_URL        (default http://localhost:4100)
//       JWT_SECRET      (default "testsecret"; only used to forge tokens for negative tests)
//       SYSTEM_PASSWORD (default "adminpass")
//       PGHOST/PGPORT/PGDATABASE/PGUSER  (default /tmp/pgtest, 5433, qb_test, postgres) - psql is used for
//                       fixtures that cannot be built through the API (expired OTPs, back-dated licences ...).
//                       Tests that need psql are skipped when it is unavailable.
//       SERVER_LOG      (default /tmp/pgtest/server.log) - scanned for 'Error' lines at the end.
//       QB_TEST_CLEANUP=1  delete every tenant this run created via the system API (off by default).
//
// THE CLOCK. The server reads the time itself (in the time zone of the service's location) and ignores any clockMinutes /
// nowMinutes a client sends, so tests that depend on the time of day move the server's TEST CLOCK (POST /api/system/test-now,
// which exists only when the API runs with NODE_ENV=test). The suite starts it at 00:00 London on today's date (it then runs on in real time, so
// created_at ordering still works) and `setClock` / `atMinutes` move it; it is released at the end. Run this suite against an API started with NODE_ENV=test.
//
// Conventions: everything created is prefixed `api-test-`. The suite never deletes other tenants and never
// touches the simulated clock. Every request carries a random X-Forwarded-For so the in-memory per-IP rate
// limiter / per-IP ticket cap used by other concurrent clients is not consumed (the server trusts one proxy hop, so a single X-Forwarded-For entry is taken as the client address).
//
// Tests whose title carries [D##] assert intended behaviour that the app currently violates (genuine defects,
// see the report). Everything else is expected to pass.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
const SYSTEM_PASSWORD = process.env.SYSTEM_PASSWORD || 'adminpass';
const PG = {
  host: process.env.PGHOST || '/tmp/pgtest', port: process.env.PGPORT || '5433',
  db: process.env.PGDATABASE || 'qb_test', user: process.env.PGUSER || 'postgres',
};
const SERVER_LOG = process.env.SERVER_LOG || '/tmp/pgtest/server.log';

const RUN = crypto.randomBytes(3).toString('hex');
const rnd = () => crypto.randomBytes(4).toString('hex');
const ri = (n) => crypto.randomInt(n);
const randIp = () => `10.${ri(250) + 1}.${ri(250) + 1}.${ri(250) + 1}`;
const UUID0 = '00000000-0000-4000-8000-000000000000';
const ALLDAY = Array.from({ length: 48 }, (_, i) => i * 30); // 00:00 .. 23:30 block starts

// ---------------------------------------------------------------- http helpers
async function api(method, path, { token, body, rawBody, ip, headers = {} } = {}) {
  const h = { 'x-forwarded-for': ip || randIp(), ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; h['content-type'] = h['content-type'] || 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const get = (p, o) => api('GET', p, o);
const post = (p, body, o = {}) => api('POST', p, { ...o, body });
const put = (p, body, o = {}) => api('PUT', p, { ...o, body });
const patch = (p, body, o = {}) => api('PATCH', p, { ...o, body });
const del = (p, o) => api('DELETE', p, o);

// ---------------------------------------------------------------- psql helpers
let PSQL_OK = false;
function sql(q) {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlJson(q) { return JSON.parse(sql(`select coalesce(json_agg(t),'[]'::json) from (${q}) t`)); }
try { PSQL_OK = sql('select 1') === '1'; } catch { PSQL_OK = false; }
const needsDb = { skip: PSQL_OK ? false : 'psql not available' };

// ---------------------------------------------------------------- misc helpers
const b64u = (b) => Buffer.from(b).toString('base64url');
function forgeJwt(payload, { secret = JWT_SECRET, alg = 'HS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, typ: 'JWT' })); const p = b64u(JSON.stringify(payload));
  const sig = alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function decodeJwt(t) { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); }
function addDays(dateStr, n) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function today() { return (await get('/api/public/clock')).json.today; }

// --- the server's test clock (see the header) ---
const londonParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
function londonInstant(date, minutes) {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
  const p = londonParts(guess);
  const offset = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(guess / 1000) * 1000) / 60000;
  return new Date(guess - offset * 60000).toISOString();
}
const DEFAULT_MINUTES = 0;
let CLOCK_DATE = null; // the London date the clock is frozen on
let CLOCK_OK = false;
async function setClock(minutes) {
  if (!CLOCK_OK) return;
  const r = await post('/api/system/test-now', { now: londonInstant(CLOCK_DATE, minutes) }, { token: await systemToken() });
  assert.equal(r.status, 200, `could not move the server's test clock: ${r.text}`);
}
// Runs fn with the server clock at `minutes` past London midnight, then puts it back at the default. (undefined = leave it.)
async function atMinutes(minutes, fn) {
  if (minutes === undefined || minutes === null || Number.isNaN(Number(minutes)) || !CLOCK_OK) return fn();
  await setClock(Number(minutes));
  try { return await fn(); } finally { await setClock(DEFAULT_MINUTES); }
}

// Runs fn over every case, collecting failures so one test reports every offending input.
async function forAll(cases, fn) {
  const bad = [];
  for (const c of cases) {
    try { const msg = await fn(c); if (msg) bad.push(`${typeof c === 'string' ? c : JSON.stringify(c)} -> ${msg}`); }
    catch (e) { bad.push(`${JSON.stringify(c)} -> threw ${e.message}`); }
  }
  assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
}
const is4xx = (s) => s >= 400 && s < 500;

// ---------------------------------------------------------------- fixtures
const createdTenants = [];
let sysToken;
async function systemToken() {
  if (!sysToken) sysToken = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token;
  return sysToken;
}

// Real signup can be blocked in sandboxes without DNS (emailCheck.js treats ENOTFOUND as "no MX"). We probe once;
// when blocked, fixtures are seeded through psql and the sign-up-only tests are skipped.
const probeEmail = `api-test-${RUN}-probe-${rnd()}@example.com`;
const probe = await post('/api/auth/signup', { businessName: `api-test-probe-${rnd()}`, firstName: 'P', lastName: 'P', email: probeEmail, locations: [{ name: 'Main' }], services: [{ name: 'Svc', locationIndex: 0 }] }).catch((e) => ({ status: 0, text: String(e) }));
if (probe.status === 0) throw new Error(`Cannot reach ${BASE}: ${probe.text}`);
const dnsDown = probe.status === 400 && /receive mail/.test(probe.text);
if (probe.status === 200) createdTenants.push(probe.json.tenant.id);
const needsSignup = { skip: dnsDown ? 'signup blocked: no DNS/MX in this environment' : false };
if (dnsDown) console.log('# NOTE: signup is blocked by the MX check (no DNS) - seeding tenants via psql, signup-success tests skipped');
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const code6 = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[ri(32)]).join('');

// Start the server's clock at 00:00 on today's London date for the run (skipped, with a note, if this API has no test clock).
{
  CLOCK_DATE = londonParts(Date.now()); CLOCK_DATE = `${CLOCK_DATE.year}-${CLOCK_DATE.month}-${CLOCK_DATE.day}`;
  const tok = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json?.token;
  const r = tok ? await post('/api/system/test-now', { now: londonInstant(CLOCK_DATE, DEFAULT_MINUTES) }, { token: tok }) : { status: 0 };
  CLOCK_OK = r.status === 200;
  if (!CLOCK_OK) console.log('# NOTE: this API has no test clock (needs NODE_ENV=test): time-of-day tests will use the real clock and may fail');
}

function seedTenant(body) {
  const tid = sql(`insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name)
    values (${q(body.businessName)},${q(body.email)},${body.locations.length},${q(code6())},'card','active','Api','Tester') returning id`);
  const locIds = body.locations.map((l) => {
    const id = sql(`insert into locations (tenant_id,name,address,staff_access_code) values ('${tid}',${q(l.name)},'',${q(code6() + '-' + rnd())}) returning id`);
    sql(`insert into location_codes (code,tenant_id,location_id) values ('QB-${code6()}','${tid}','${id}')`);
    return id;
  });
  body.services.forEach((s, i) => {
    const id = sql(`insert into services (tenant_id,location_id,name,mode,slot_minutes) values ('${tid}','${locIds[s.locationIndex]}',${q(s.name)},${q(s.mode || 'hybrid')},${s.slotMinutes || 15}) returning id`);
    if (i === 0) sql(`insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status) values ('${tid}','${id}','trial','2-day free trial',2,0,'available')`);
  });
  return tid;
}

async function signup({ label = 't', locations = [{ name: 'Main' }], services = [{ name: 'Dental Care', locationIndex: 0, mode: 'hybrid', slotMinutes: 15 }], email } = {}) {
  email = email || `api-test-${RUN}-${label}-${rnd()}@example.com`;
  const body = { businessName: `api-test-${label}-${rnd()}`, firstName: 'Api', lastName: 'Tester', email, locations, services };
  let id, tenant, otp;
  if (dnsDown) {
    id = seedTenant(body);
    createdTenants.push(id);
    otp = (await post('/api/auth/admin/request-otp', { email })).json.demoOtp;
  } else {
    const r = await post('/api/auth/signup', body);
    assert.equal(r.status, 200, `signup failed: ${r.text}`);
    id = r.json.tenant.id; tenant = r.json.tenant; otp = r.json.demoOtp;
    createdTenants.push(id);
  }
  const v = await post('/api/auth/admin/verify-otp', { email, code: otp });
  assert.equal(v.status, 200, `verify failed: ${v.text}`);
  const token = v.json.token;
  const locs = (await get('/api/tenant/locations', { token })).json.locations;
  const svcs = (await get('/api/tenant/services', { token })).json.services;
  return { email, token, id, tenant: tenant || v.json.tenant, businessName: body.businessName, locations: locs, services: svcs };
}

async function buyLicence(t, svcId, planId = 'month', extra = {}) {
  const r = await post(`/api/tenant/services/${svcId}/licenses`, { planId, paymentMethod: 'card', ...extra }, { token: t.token });
  assert.equal(r.status, 200, `buy licence failed: ${r.text}`);
  return r.json.license;
}
async function schedule(t, svcId, licId, startDate) {
  return patch(`/api/tenant/services/${svcId}/licenses/${licId}`, { startDate }, { token: t.token });
}
async function putDay(t, svcId, date, o = {}) {
  // `nowMinutes` here is not sent to the server (it ignores it): it is the time of day the SERVER clock is moved to for this call.
  const { nowMinutes, ...rest } = o;
  return atMinutes(nowMinutes, () => put(`/api/tenant/services/${svcId}/daily-config`,
    { date, hours: ALLDAY, staffCount: 3, bookingStaffCount: 2, walkInStaffCount: 1, ...rest }, { token: t.token }));
}
// Month licence starting today + hours on today..today+days-1. Returns { today, dates, licence }.
async function goLive(t, svc, { days = 4, hours = ALLDAY, staffCount = 3, bookingStaffCount = 2, walkInStaffCount = 1 } = {}) {
  const d0 = await today();
  const lic = await buyLicence(t, svc.id, 'month');
  const s = await schedule(t, svc.id, lic.id, d0);
  assert.equal(s.status, 200, `schedule failed: ${s.text}`);
  const dates = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(d0, i); dates.push(date);
    const r = await putDay(t, svc.id, date, { hours, staffCount, bookingStaffCount, walkInStaffCount });
    assert.equal(r.status, 200, `putDay ${date} failed: ${r.text}`);
  }
  return { today: d0, dates, licence: s.json.license };
}

async function addStaff(t, first = 'Sam', last = 'Staff') {
  const email = `api-test-staff-${RUN}-${rnd()}@example.com`;
  if (dnsDown) {
    const id = sql(`insert into staff_members (tenant_id,first_name,last_name,email) values ('${t.id}',${q(first)},${q(last)},${q(email)}) returning id`);
    return { id, email };
  }
  const r = await post('/api/tenant/staff', { firstName: first, lastName: last, email }, { token: t.token });
  assert.equal(r.status, 200, `add staff failed: ${r.text}`);
  return { id: r.json.staff.id, email };
}
async function staffLogin(email) {
  const r = await post('/api/auth/staff/request-otp', { email });
  assert.ok(r.json?.demoOtp, `no demoOtp: ${r.text}`);
  const v = await post('/api/auth/staff/verify-otp', { email, code: r.json.demoOtp });
  assert.equal(v.status, 200, `staff verify failed: ${v.text}`);
  return v.json.token;
}

// Public API shortcuts
const P = (t) => `/api/public/tenant/${t.id}`;
async function join(t, svcId, body, ip) {
  return post(`${P(t)}/services/${svcId}/tickets`, body, { ip });
}
const walkIn = (t, svcId, date, hourBlock = 540, extra = {}, ip) => join(t, svcId, { type: 'walk_in', date, hourBlock, ...extra }, ip);
const booked = (t, svcId, date, slotTime = 540, extra = {}, ip) => join(t, svcId, { type: 'booked', date, slotTime, ...extra }, ip);

const logStart = (() => { try { return fs.statSync(SERVER_LOG).size; } catch { return null; } })();

after(async () => {
  if (CLOCK_OK) await del('/api/system/test-now', { token: await systemToken() }); // back to the real clock
  if (process.env.QB_TEST_CLEANUP === '1') {
    const token = await systemToken();
    for (const id of createdTenants) await del(`/api/system/tenants/${id}`, { token });
  }
});

// =====================================================================================
// 1. SIGN-UP & AUTH
// =====================================================================================
describe('1. Sign-up & auth', () => {
  const validBody = () => ({
    businessName: `api-test-val-${rnd()}`, firstName: 'A', lastName: 'B', email: `api-test-${RUN}-${rnd()}@example.com`,
    locations: [{ name: 'Main' }], services: [{ name: 'Svc', locationIndex: 0 }],
  });
  const tenantCount = (email) => (PSQL_OK ? Number(sql(`select count(*) from tenants where lower(email)=lower('${email}')`)) : null);

  describe('signup validation', () => {
    for (const field of ['email', 'businessName', 'firstName', 'lastName', 'locations', 'services']) {
      it(`rejects a missing ${field} with 400 and creates nothing`, async () => {
        const b = validBody(); delete b[field];
        const r = await post('/api/auth/signup', b);
        assert.equal(r.status, 400, r.text);
        if (PSQL_OK) assert.equal(tenantCount(b.email), 0);
      });
    }
    it('rejects empty locations / services arrays', async () => {
      assert.equal((await post('/api/auth/signup', { ...validBody(), locations: [] })).status, 400);
      assert.equal((await post('/api/auth/signup', { ...validBody(), services: [] })).status, 400);
    });
    it('rejects blank location / service names and missing locationIndex', async () => {
      assert.equal((await post('/api/auth/signup', { ...validBody(), locations: [{ name: '   ' }] })).status, 400);
      assert.equal((await post('/api/auth/signup', { ...validBody(), services: [{ name: ' ', locationIndex: 0 }] })).status, 400);
      assert.equal((await post('/api/auth/signup', { ...validBody(), services: [{ name: 'x' }] })).status, 400);
    });
    it('rejects duplicate location names (case/space-insensitive)', async () => {
      const r = await post('/api/auth/signup', { ...validBody(), locations: [{ name: 'North' }, { name: ' north ' }] });
      assert.equal(r.status, 400, r.text);
    });
    it('[D01] rejects a service whose locationIndex is out of range with 400 (not 500)', needsSignup, async () => {
      for (const idx of [5, -1]) {
        const b = validBody(); b.services = [{ name: 'Svc', locationIndex: idx }];
        const r = await post('/api/auth/signup', b);
        assert.equal(r.status, 400, `locationIndex ${idx}: ${r.status} ${r.text}`);
        if (PSQL_OK) assert.equal(tenantCount(b.email), 0, 'no half-created tenant');
      }
    });
    it('[D02] rejects wrongly-typed fields with 400 (not 500 / not silently accepted)', async () => {
      const variants = {
        'locations is a string': (b) => { b.locations = 'abc'; },
        'locations is a number': (b) => { b.locations = 5; },
        'locations is an object with length': (b) => { b.locations = { length: 1 }; },
        'location name is a number': (b) => { b.locations = [{ name: 5 }]; },
        'location name is an array': (b) => { b.locations = [{ name: ['x'] }]; },
        'services is a string': (b) => { b.services = 'abc'; },
        'service name is a number': (b) => { b.services = [{ name: 7, locationIndex: 0 }]; },
        'service locationIndex is an object': (b) => { b.services = [{ name: 'x', locationIndex: {} }]; },
        'email is a number': (b) => { b.email = 12345; },
        'email is an array': (b) => { b.email = [`api-test-${rnd()}@example.com`]; },
        'email is an object': (b) => { b.email = { a: 1 }; },
        'businessName is an object': (b) => { b.businessName = { a: 1 }; },
        'businessName is an array': (b) => { b.businessName = ['x']; },
        'firstName is a number': (b) => { b.firstName = 5; },
      };
      const keys = Object.keys(variants).filter((k) => !dnsDown || !/businessName|firstName|email is an array/.test(k)); // those checks sit behind the MX lookup
      await forAll(keys, async (k) => {
        const b = validBody(); variants[k](b);
        const r = await post('/api/auth/signup', b);
        return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 80)}`;
      });
    });
    it('[D03] rejects syntactically invalid email addresses', needsSignup, async () => {
      await forAll(['plainstring', 'two words@example.com', 'a@@example.com', '@example.com', 'a@', 'a@b'], async (email) => {
        const b = validBody(); b.email = email;
        const r = await post('/api/auth/signup', b);
        return r.status === 400 ? null : `${r.status}`;
      });
    });
    it('rejects a null byte in text fields without a 500', needsSignup, async () => {
      const b = validBody(); b.locations = [{ name: 'Ma\u0000in' }];
      const r = await post('/api/auth/signup', b);
      assert.ok(is4xx(r.status), `${r.status} ${r.text}`);
    });
  });

  describe('signup success + duplicates', () => {
    let first;
    before(async () => { first = await signup({ label: 'dup', locations: [{ name: 'A' }, { name: 'B' }], services: [{ name: 'One', locationIndex: 0 }, { name: 'Two', locationIndex: 1, mode: 'queue' }] }); });

    it('creates an active tenant with locations, services, trial licence on first service only', async () => {
      assert.equal(first.tenant.status, 'active');
      assert.equal(first.tenant.location_count, 2);
      assert.equal(first.locations.length, 2);
      assert.equal(first.services.length, 2);
      assert.ok(first.locations.every((l) => /^QB-[A-Z2-9]{6}$/.test(l.code)), 'location codes');
      const lic = (await get('/api/tenant/licenses', { token: first.token })).json.licenses;
      assert.equal(lic.length, 1);
      assert.equal(lic[0].plan_id, 'trial');
      assert.equal(lic[0].status, 'available');
      assert.equal(lic[0].plan_days, 2);
      assert.equal(lic[0].service_id, first.services.find((s) => s.name === 'One').id);
    });
    it('does not leak admin-only fields (signup_country) in signup / verify / me', async () => {
      assert.ok(!('signup_country' in first.tenant));
      const me = (await get('/api/tenant/me', { token: first.token })).json;
      assert.ok(!('signup_country' in me.tenant));
    });
    it('writes an audit-log entry', needsSignup, async () => {
      const log = (await get('/api/tenant/audit-log', { token: first.token })).json.auditLog;
      assert.ok(log.some((l) => /Account activated/.test(l.message)));
    });
    it('same email (any case) does not create a second account and returns alreadyExists + a working OTP', needsSignup, async () => {
      const r = await post('/api/auth/signup', { ...validBody(), email: first.email.toUpperCase() });
      assert.equal(r.status, 200);
      assert.equal(r.json.alreadyExists, true);
      assert.match(r.json.demoOtp, /^\d{6}$/);
      if (PSQL_OK) assert.equal(tenantCount(first.email), 1);
      const v = await post('/api/auth/admin/verify-otp', { email: first.email, code: r.json.demoOtp });
      assert.equal(v.status, 200);
    });
    it('[D04] concurrent signups with one email never 500 and create exactly one account', needsSignup, async () => {
      const b = validBody();
      const rs = await Promise.all([1, 2, 3, 4].map(() => post('/api/auth/signup', { ...b, businessName: `api-test-race-${rnd()}` })));
      const codes = rs.map((r) => r.status);
      assert.ok(codes.every((c) => c === 200), `statuses ${codes}`);
      if (PSQL_OK) assert.equal(tenantCount(b.email), 1);
    });
    it('a disabled account cannot re-signup / sign in, and nothing reveals that it exists (uniform 200 / 401)', async () => {
      const t = await signup({ label: 'disabled' });
      const st = await systemToken();
      assert.equal((await patch(`/api/system/tenants/${t.id}`, { status: 'disabled' }, { token: st })).status, 200);
      // CHANGED (account enumeration): these used to answer 403 "disabled"; now the same 200 / 401 as an unknown address, no code issued.
      if (!dnsDown) { const r = await post('/api/auth/signup', { ...validBody(), email: t.email }); assert.equal(r.status, 200); assert.ok(!r.json.demoOtp); }
      const rq = await post('/api/auth/admin/request-otp', { email: t.email }); assert.equal(rq.status, 200); assert.ok(!rq.json.demoOtp);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: t.email, code: '123456' })).status, 401);
      // an already-issued token is blocked too
      assert.equal((await get('/api/tenant/me', { token: t.token })).status, 403);
      // public side hides it
      assert.equal((await get(`/api/public/tenant/${t.id}/info`)).status, 404);
      // re-enable restores access
      await patch(`/api/system/tenants/${t.id}`, { status: 'active' }, { token: st });
      assert.equal((await get('/api/tenant/me', { token: t.token })).status, 200);
    });
  });

  describe('tenant admin OTP', () => {
    let t;
    before(async () => { t = await signup({ label: 'otp' }); });
    const reqOtp = async (email = t.email) => (await post('/api/auth/admin/request-otp', { email })).json.demoOtp;
    const wrongCode = (c) => (c === '111111' ? '222222' : '111111');

    it('request-otp: unknown email -> same 200 as a known one (no code), valid -> 6-digit demoOtp, case-insensitive', async () => {
      // CHANGED (account enumeration): unknown used to be 404 "No account found".
      const unknown = await post('/api/auth/admin/request-otp', { email: `api-test-nobody-${rnd()}@example.com` });
      assert.equal(unknown.status, 200); assert.equal(unknown.json.ok, true); assert.ok(!unknown.json.demoOtp);
      const r = await post('/api/auth/admin/request-otp', { email: t.email.toUpperCase() });
      assert.equal(r.status, 200);
      assert.match(r.json.demoOtp, /^\d{6}$/);
    });
    it('verify: wrong code -> 401, no token', async () => {
      const c = await reqOtp();
      const r = await post('/api/auth/admin/verify-otp', { email: t.email, code: wrongCode(c) });
      assert.equal(r.status, 401);
      assert.ok(!r.json.token);
    });
    it('verify: right code -> token (tenant_admin, 12h by default) + tenant; no signup_country', async () => {
      const c = await reqOtp();
      const r = await post('/api/auth/admin/verify-otp', { email: t.email, code: c });
      assert.equal(r.status, 200);
      const p = decodeJwt(r.json.token);
      assert.equal(p.role, 'tenant_admin'); assert.equal(p.tenantId, t.id);
      assert.ok(p.exp - p.iat >= 12 * 3600 - 5 && p.exp - p.iat <= 12 * 3600 + 5, `lifetime ${p.exp - p.iat}s`); // CHANGED: was 30 days
      assert.ok(!('signup_country' in r.json.tenant));
    });
    it('verify: an OTP cannot be reused', async () => {
      const c = await reqOtp();
      assert.equal((await post('/api/auth/admin/verify-otp', { email: t.email, code: c })).status, 200);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: t.email, code: c })).status, 401);
    });
    it('verify: an expired OTP is rejected', needsDb, async () => {
      const c = await reqOtp();
      sql(`update admin_otp set expires_at = now() - interval '1 minute' where tenant_id='${t.id}'`);
      assert.equal((await post('/api/auth/admin/verify-otp', { email: t.email, code: c })).status, 401);
    });
    it('verify: tenant A\'s OTP does not sign in tenant B', async () => {
      const other = await signup({ label: 'otp2' });
      const c = await reqOtp();
      assert.equal((await post('/api/auth/admin/verify-otp', { email: other.email, code: c })).status, 401);
    });
    it('[D05] verify: OTP is locked after repeated wrong guesses (brute-force protection)', async () => {
      const c = await reqOtp();
      for (let i = 0; i < 8; i++) await post('/api/auth/admin/verify-otp', { email: t.email, code: wrongCode(c) });
      const r = await post('/api/auth/admin/verify-otp', { email: t.email, code: c });
      assert.equal(r.status, 401, 'correct code still accepted after 8 wrong attempts - 6-digit code can be brute-forced');
    });
    it('[D06] request-otp is throttled (429) so OTP guessing / email bombing cannot be unlimited', async () => {
      const ip = randIp(); let got429 = false;
      for (let i = 0; i < 25 && !got429; i++) got429 = (await post('/api/auth/admin/request-otp', { email: t.email }, { ip })).status === 429;
      assert.ok(got429, '25 OTP requests in a row from one IP were all accepted');
    });
    it('wrongly-typed email/code yields 4xx, not 500 (admin verify + request)', async () => {
      const cases = [
        ['verify', { email: ['a@b.com'], code: '123456' }], ['verify', { email: { a: 1 }, code: '123456' }], ['verify', { email: 5, code: '1' }],
        ['verify', { email: t.email, code: ['1'] }], ['verify', { email: t.email, code: { $ne: 1 } }], ['verify', { email: t.email, code: null }],
        ['verify', {}], ['request', { email: ['a@b.com'] }], ['request', { email: { a: 1 } }], ['request', { email: 5 }], ['request', {}],
      ];
      await forAll(cases, async ([kind, body]) => {
        const r = await post(`/api/auth/admin/${kind === 'verify' ? 'verify-otp' : 'request-otp'}`, body);
        return is4xx(r.status) ? null : `${r.status}`;
      });
    });
  });

  describe('staff OTP', () => {
    let t, staff;
    before(async () => { t = await signup({ label: 'staffotp' }); staff = await addStaff(t, 'Sally', 'Staffer'); });
    const reqOtp = async () => (await post('/api/auth/staff/request-otp', { email: staff.email })).json.demoOtp;
    const wrong = (c) => (c === '111111' ? '222222' : '111111');

    it('staff management validation: bad / duplicate / missing email', async () => {
      assert.equal((await post('/api/tenant/staff', { firstName: 'a', lastName: 'b', email: 'nope' }, { token: t.token })).status, 400);
      assert.equal((await post('/api/tenant/staff', { firstName: 'a', lastName: 'b' }, { token: t.token })).status, 400);
      assert.equal((await post('/api/tenant/staff', { firstName: '', lastName: 'b', email: `api-test-${rnd()}@example.com` }, { token: t.token })).status, 400);
      if (!dnsDown) assert.equal((await post('/api/tenant/staff', { firstName: 'a', lastName: 'b', email: staff.email.toUpperCase() }, { token: t.token })).status, 409);
    });
    it('happy path: request -> verify returns 16h staff token + staff info', async () => {
      const c = await reqOtp();
      assert.match(c, /^\d{6}$/);
      const v = await post('/api/auth/staff/verify-otp', { email: staff.email, code: c });
      assert.equal(v.status, 200);
      const p = decodeJwt(v.json.token);
      assert.equal(p.role, 'staff'); assert.equal(p.tenantId, t.id); assert.equal(p.staffId, staff.id);
      assert.ok(p.exp - p.iat <= 16 * 3600 + 5); // CHANGED: was 10h; now STAFF_SESSION_HOURS (default 16) with sliding refresh
      assert.equal(v.json.staff.firstName, 'Sally');
      assert.equal((await get('/api/tenant/me', { token: v.json.token })).json.staff.email, staff.email);
    });
    it('unknown email gets the same response as a known one minus the code (no enumeration)', async () => {
      const r = await post('/api/auth/staff/request-otp', { email: `api-test-nobody-${rnd()}@example.com` });
      assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.ok(!r.json.demoOtp);
      assert.equal((await post('/api/auth/staff/verify-otp', { email: `api-test-nobody-${rnd()}@example.com`, code: '123456' })).status, 401);
    });
    it('wrong code -> 401; reuse -> 401; only the latest OTP is valid', async () => {
      const c1 = await reqOtp();
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: wrong(c1) })).status, 401);
      const c2 = await reqOtp();
      if (c1 !== c2) assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c1 })).status, 401, 'older OTP must not work');
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c2 })).status, 200);
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c2 })).status, 401, 'reuse');
    });
    it('expired OTP rejected', needsDb, async () => {
      const c = await reqOtp();
      sql(`update staff_otp set expires_at = now() - interval '1 minute' where staff_id='${staff.id}'`);
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c })).status, 401);
    });
    it('attempt limit: after 5 wrong guesses even the right code is refused', async () => {
      const c = await reqOtp();
      for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: wrong(c) })).status, 401);
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c })).status, 401);
      // a fresh OTP works again
      const c2 = await reqOtp();
      assert.equal((await post('/api/auth/staff/verify-otp', { email: staff.email, code: c2 })).status, 200);
    });
    it('[D06b] request-otp for staff is throttled (attempt counter can be reset by re-requesting)', async () => {
      const ip = randIp(); let got429 = false;
      for (let i = 0; i < 25 && !got429; i++) got429 = (await post('/api/auth/staff/request-otp', { email: staff.email }, { ip })).status === 429;
      assert.ok(got429, '25 staff OTP requests from one IP were all accepted');
    });
    it('[D07] wrongly-typed email/code yields 4xx, not 500 (staff)', async () => {
      const cases = [
        ['verify-otp', { email: 5, code: '1' }], ['verify-otp', { email: staff.email, code: 5 }], ['verify-otp', { email: staff.email, code: { a: 1 } }],
        ['verify-otp', { email: ['x'], code: '1' }], ['verify-otp', { email: staff.email, code: ['1'] }], ['verify-otp', {}],
        ['request-otp', { email: 5 }], ['request-otp', { email: { a: 1 } }], ['request-otp', { email: ['a@b.com'] }], ['request-otp', {}],
      ];
      await forAll(cases, async ([ep, body]) => {
        const r = await post(`/api/auth/staff/${ep}`, body);
        return r.status < 500 ? null : `${r.status}`;
      });
    });

    it('inactive staff: cannot request, cannot verify a pre-issued code, existing session is cut off', async () => {
      const { id: sid, email } = await addStaff(t, 'Ina', 'Ctive');
      const sessionToken = await staffLogin(email);
      assert.equal((await get('/api/tenant/me', { token: sessionToken })).status, 200);
      const preIssued = (await post('/api/auth/staff/request-otp', { email })).json.demoOtp;

      assert.equal((await patch(`/api/tenant/staff/${sid}`, { active: false }, { token: t.token })).json.staff.active, false);

      assert.equal((await get('/api/tenant/me', { token: sessionToken })).status, 401, 'existing session');
      const rq = await post('/api/auth/staff/request-otp', { email });
      assert.equal(rq.status, 200); assert.ok(!rq.json.demoOtp, 'no OTP issued to inactive staff');
      if (PSQL_OK) assert.equal(Number(sql(`select count(*) from staff_otp where staff_id='${sid}' and consumed=false and expires_at>now()`)), 1, 'only the pre-issued OTP exists');
      assert.equal((await post('/api/auth/staff/verify-otp', { email, code: preIssued })).status, 401, 'pre-issued code');

      // re-activate: sign-in works again
      await patch(`/api/tenant/staff/${sid}`, { active: true }, { token: t.token });
      assert.ok(await staffLogin(email));
    });
    it('deleted staff: session ends immediately; cannot sign in', async () => {
      const { id: sid, email } = await addStaff(t, 'De', 'Leted');
      const sessionToken = await staffLogin(email);
      assert.equal((await del(`/api/tenant/staff/${sid}`, { token: t.token })).status, 200);
      assert.equal((await get('/api/tenant/me', { token: sessionToken })).status, 401);
      assert.ok(!(await post('/api/auth/staff/request-otp', { email })).json.demoOtp);
    });
    it('staff of a disabled tenant: request gets the uniform 200 (no code), verify -> 401, and the session is blocked (403)', async () => {
      const t2 = await signup({ label: 'staffdis' }); const s2 = await addStaff(t2);
      const tok = await staffLogin(s2.email);
      const code = (await post('/api/auth/staff/request-otp', { email: s2.email })).json.demoOtp;
      const st = await systemToken();
      await patch(`/api/system/tenants/${t2.id}`, { status: 'disabled' }, { token: st });
      // CHANGED (account enumeration): these used to answer 403 "disabled".
      const rq = await post('/api/auth/staff/request-otp', { email: s2.email }); assert.equal(rq.status, 200); assert.ok(!rq.json.demoOtp);
      assert.equal((await post('/api/auth/staff/verify-otp', { email: s2.email, code })).status, 401);
      assert.equal((await get('/api/tenant/me', { token: tok })).status, 403);
    });
    it('staff-token forged for a staff id of a different tenant is rejected', async () => {
      const other = await signup({ label: 'staffx' });
      const forged = forgeJwt({ role: 'staff', tenantId: other.id, staffId: staff.id, iat: nowSec(), exp: nowSec() + 600 });
      assert.equal((await get('/api/tenant/me', { token: forged })).status, 401);
    });
  });

  describe('system admin login', () => {
    it('wrong / empty / missing password -> 401, no token', async () => {
      for (const body of [{ password: 'nope' }, { password: '' }, {}, { password: 'ADMINPASS' }]) {
        const r = await post('/api/auth/system/login', body);
        assert.equal(r.status, 401, JSON.stringify(body)); assert.ok(!r.json.token);
      }
    });
    it('correct password -> system_admin token that works on /api/system', async () => {
      const r = await post('/api/auth/system/login', { password: SYSTEM_PASSWORD });
      assert.equal(r.status, 200);
      assert.equal(decodeJwt(r.json.token).role, 'system_admin');
      assert.equal((await get('/api/system/tenants', { token: r.json.token })).status, 200);
    });
    it('[D08] wrongly-typed password yields 401, not 500', async () => {
      await forAll([{ password: 123 }, { password: ['a'] }, { password: { a: 1 } }, { password: true }], async (b) => {
        const r = await post('/api/auth/system/login', b);
        return r.status === 401 ? null : `${r.status}`;
      });
    });
    it('tenant / staff / no token cannot use system routes', async () => {
      const t = await signup({ label: 'sysauth' });
      assert.equal((await get('/api/system/tenants', { token: t.token })).status, 403);
      assert.equal((await get('/api/system/tenants')).status, 401);
      assert.equal((await post('/api/system/clock', { date: '2030-01-01' }, { token: t.token })).status, 403);
      assert.equal((await get('/api/public/clock')).json.simulated, false, 'clock must be untouched');
    });
  });
});

// =====================================================================================
// 2. TENANT ISOLATION & ACCESS CONTROL
// =====================================================================================
describe('2. Tenant isolation & access control', () => {
  let A, B, D0, bSvc, bSvc2, bLoc, bLoc2, aSvc, bTicketWalk, bTicketBooked, bStaff, bLic, aStaff, aStaffToken, aTicket;
  const snapshot = async (t) => {
    const g = async (p) => (await get(p, { token: t.token })).json;
    const dc = (await get(`/api/tenant/services/${bSvc.id}/daily-config?from=${D0}&to=${addDays(D0, 5)}`, { token: B.token })).json;
    return crypto.createHash('sha1').update(JSON.stringify({
      locations: (await g('/api/tenant/locations')).locations, services: (await g('/api/tenant/services?includeArchived=true')).services,
      tickets: (await g(`/api/tenant/tickets?date=${D0}`)).tickets, staff: (await g('/api/tenant/staff')).staff,
      licenses: (await g('/api/tenant/licenses')).licenses, dc: dc.dailyConfig,
    })).digest('hex');
  };

  before(async () => {
    D0 = await today();
    A = await signup({ label: 'isoA', locations: [{ name: 'A-Main' }], services: [{ name: 'Alpha Clinic', locationIndex: 0, mode: 'hybrid' }] });
    B = await signup({ label: 'isoB', locations: [{ name: 'B-Main' }, { name: 'B-Annex' }], services: [{ name: 'Beta Clinic', locationIndex: 0, mode: 'hybrid' }, { name: 'Beta Pharmacy', locationIndex: 1, mode: 'queue' }] });
    aSvc = A.services[0]; [bSvc, bSvc2] = B.services; [bLoc, bLoc2] = B.locations;
    await goLive(A, aSvc); await goLive(B, bSvc);
    bLic = (await get(`/api/tenant/services/${bSvc.id}/licenses`, { token: B.token })).json.licenses[0];
    bTicketWalk = (await walkIn(B, bSvc.id, D0, 540)).json.ticket;
    bTicketBooked = (await booked(B, bSvc.id, D0, 600)).json.ticket;
    aTicket = (await walkIn(A, aSvc.id, D0, 540)).json.ticket;
    bStaff = await addStaff(B, 'Bea', 'Bstaff'); aStaff = await addStaff(A, 'Al', 'Astaff');
    aStaffToken = await staffLogin(aStaff.email);
    assert.ok(bTicketWalk?.id && bTicketBooked?.id && aTicket?.id);
  });

  describe('A\'s admin token against B\'s real IDs', () => {
    const attacks = () => [
      ['PATCH', `/api/tenant/locations/${bLoc.id}`, { name: 'pwned' }],
      ['PATCH', `/api/tenant/services/${bSvc.id}`, { name: 'pwned', archived: true }],
      ['GET', `/api/tenant/services/${bSvc.id}/licenses`],
      ['POST', `/api/tenant/services/${bSvc.id}/licenses`, { planId: 'day', paymentMethod: 'card' }],
      ['PATCH', `/api/tenant/services/${bSvc.id}/licenses/${bLic.id}`, { startDate: addDays(D0, 100) }],
      ['PATCH', `/api/tenant/services/${bSvc.id}/licenses/${bLic.id}`, { unschedule: true }],
      ['POST', `/api/tenant/services/${bSvc.id}/licenses/${bLic.id}/move`, { targetServiceId: aSvc.id }],
      ['POST', `/api/tenant/services/${bSvc.id}/licenses/${bLic.id}/refund`, {}],
      ['POST', `/api/tenant/services/${bSvc.id}/licenses/${bLic.id}/pay`, { paymentMethod: 'card' }],
      // B's licence id through A's own service path
      ['PATCH', `/api/tenant/services/${aSvc.id}/licenses/${bLic.id}`, { startDate: addDays(D0, 100) }],
      ['POST', `/api/tenant/services/${aSvc.id}/licenses/${bLic.id}/move`, { targetServiceId: aSvc.id }],
      ['POST', `/api/tenant/services/${aSvc.id}/licenses/${bLic.id}/refund`, {}],
      ['POST', `/api/tenant/services/${aSvc.id}/licenses/${bLic.id}/pay`, { paymentMethod: 'card' }],
      ['PUT', `/api/tenant/services/${bSvc.id}/daily-config`, { date: D0, hours: [], staffCount: 1 }],
      ['GET', `/api/tenant/today?serviceId=${bSvc.id}`],
      ['GET', `/api/tenant/services/${bSvc.id}/availability?date=${D0}&clockMinutes=500`],
      ['POST', `/api/tenant/services/${bSvc.id}/tickets`, { type: 'walk_in', date: D0, hourBlock: 540 }],
      ['POST', `/api/tenant/services/${bSvc.id}/call-next`, { date: D0, clockMinutes: 900, roomLabel: 'R1' }],
      ['PATCH', `/api/tenant/staff/${bStaff.id}`, { firstName: 'pwned', active: false }],
      ['DELETE', `/api/tenant/staff/${bStaff.id}`],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/call`, { roomLabel: 'R1' }],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/call-again`, { roomLabel: 'R1' }],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/return-to-queue`, { clockMinutes: 600 }],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/cancel`, {}],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/no-show`, {}],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/route`, { newServiceId: aSvc.id, clockMinutes: 600 }],
      ['POST', `/api/tenant/tickets/${bTicketWalk.id}/close`, {}],
      // A's own ticket/licence pushed INTO B
      ['POST', `/api/tenant/tickets/${aTicket.id}/route`, { newServiceId: bSvc.id, clockMinutes: 600 }],
    ];
    it('every cross-tenant write/read is refused with 4xx and B\'s data is unchanged', async () => {
      const before = await snapshot(B);
      await forAll(attacks(), async ([m, p, body]) => {
        const r = await api(m, p, { token: A.token, body });
        return is4xx(r.status) ? null : `${r.status} ${r.text.slice(0, 100)}`;
      });
      assert.ok((await snapshot(B)) === before, 'B data changed');
    });
    it('A\'s read endpoints contain none of B\'s ids / names', async () => {
      const blob = JSON.stringify(await Promise.all(['/api/tenant/locations', '/api/tenant/services?includeArchived=true', '/api/tenant/staff', '/api/tenant/licenses',
        `/api/tenant/tickets?date=${D0}`, '/api/tenant/audit-log', `/api/tenant/dashboard/stats?date=${D0}`, '/api/tenant/me'].map(async (p) => (await get(p, { token: A.token })).json)));
      const needles = [B.id, bLoc.id, bLoc2.id, bSvc.id, bSvc2.id, bTicketWalk.id, bTicketBooked.id, bStaff.id, bStaff.email, B.businessName, bLic.id, B.email];
      for (const n of needles) assert.ok(!blob.includes(n), `A's responses contain B value ${n}`);
      assert.ok(blob.includes(aTicket.id));
    });
    it('dashboard stats and ticket list are scoped to the caller', async () => {
      const a = (await get(`/api/tenant/dashboard/stats?date=${D0}`, { token: A.token })).json.stats;
      assert.equal(a.waiting, 1); assert.equal(a.booked, 0);
      const b = (await get(`/api/tenant/dashboard/stats?date=${D0}`, { token: B.token })).json.stats;
      assert.equal(b.waiting, 1); assert.equal(b.booked, 1);
    });
    it('[D09] daily-config GET refuses another tenant\'s service (no data leak)', async () => {
      const r = await get(`/api/tenant/services/${bSvc.id}/daily-config?from=${D0}&to=${addDays(D0, 3)}`, { token: A.token });
      assert.ok(is4xx(r.status), `status ${r.status}; leaked ${r.json?.dailyConfig?.length} day rows and ${r.json?.windows?.length} licence windows of tenant B`);
    });
    it('[D10] daily-config COPY cannot overwrite another tenant\'s service', async () => {
      const before = await snapshot(B);
      const r = await post(`/api/tenant/services/${bSvc.id}/daily-config/copy`, { fromDate: addDays(D0, 20), toDates: [addDays(D0, 1), addDays(D0, 2)] }, { token: A.token });
      const after = await snapshot(B);
      assert.ok(after === before, `B's opening hours were overwritten (status ${r.status}: ${r.text})`);
      assert.ok(is4xx(r.status), `status ${r.status}`);
    });
    it('daily-config clear-all on another tenant\'s service changes nothing', async () => {
      const before = await snapshot(B);
      const r = await post(`/api/tenant/services/${bSvc.id}/daily-config/clear-all`, {}, { token: A.token });
      assert.ok(r.status < 500);
      assert.ok((await snapshot(B)) === before, 'B data changed');
    });
    it('[D11] creating a service in another tenant\'s location is refused', async () => {
      const r = await post('/api/tenant/services', { name: `api-test-xloc-${rnd()}`, locationId: bLoc.id }, { token: A.token });
      assert.ok(is4xx(r.status), `status ${r.status} - service of tenant A created inside tenant B's location`);
    });
    it('[D12] moving a ticket (PATCH) into another tenant\'s service / location is refused', async () => {
      const r = await patch(`/api/tenant/tickets/${aTicket.id}`, { serviceId: bSvc.id, locationId: bLoc.id }, { token: A.token });
      const row = PSQL_OK ? sqlJson(`select service_id, location_id from tickets where id='${aTicket.id}'`)[0] : null;
      if (row) assert.equal(row.service_id, aSvc.id, 'A\'s ticket now points at B\'s service');
      assert.ok(is4xx(r.status), `status ${r.status}`);
      // restore if the defect let it through
      if (row && row.service_id !== aSvc.id) sql(`update tickets set service_id='${aSvc.id}', location_id='${A.locations[0].id}' where id='${aTicket.id}'`);
    });
    it('PATCH /tickets/:id on another tenant\'s ticket does not change it', async () => {
      const before = await snapshot(B);
      await patch(`/api/tenant/tickets/${bTicketWalk.id}`, { status: 'cancelled' }, { token: A.token });
      assert.ok((await snapshot(B)) === before, 'B data changed');
    });
    it('[D13] PATCH/DELETE /tickets/:id on a missing / foreign ticket returns 404, not 200', async () => {
      for (const id of [bTicketWalk.id, UUID0]) {
        const r = await patch(`/api/tenant/tickets/${id}`, { status: 'cancelled' }, { token: A.token });
        assert.equal(r.status, 404, `PATCH ${id}: ${r.status} ${r.text}`);
        const d = await del(`/api/tenant/tickets/${id}`, { token: A.token });
        assert.equal(d.status, 404, `DELETE ${id}: ${d.status} ${d.text}`);
      }
    });
    it('A cannot register an email that belongs to B\'s staff, and cannot move A\'s licence into B\'s service', async () => {
      const aLic = (await get(`/api/tenant/services/${aSvc.id}/licenses`, { token: A.token })).json.licenses.find((l) => l.status === 'available');
      const r = await post(`/api/tenant/services/${aSvc.id}/licenses/${aLic.id}/move`, { targetServiceId: bSvc.id }, { token: A.token });
      assert.equal(r.status, 404);
      assert.equal((await get(`/api/tenant/services/${aSvc.id}/licenses`, { token: A.token })).json.licenses.find((l) => l.id === aLic.id).service_id, aSvc.id);
    });
    it('staff of A cannot touch B\'s tickets either', async () => {
      const before = await snapshot(B);
      for (const ep of ['call', 'cancel', 'no-show', 'close', 'return-to-queue', 'call-again']) {
        const r = await post(`/api/tenant/tickets/${bTicketWalk.id}/${ep}`, { roomLabel: 'R', clockMinutes: 600 }, { token: aStaffToken });
        assert.ok(is4xx(r.status), `${ep}: ${r.status}`);
      }
      assert.ok((await snapshot(B)) === before, 'B data changed');
    });
  });

  describe('public endpoints with the wrong tenantId', () => {
    it('B\'s service / ticket via A\'s tenantId -> 404 and B\'s ticket untouched', async () => {
      const before = await snapshot(B);
      const base = `/api/public/tenant/${A.id}`;
      const calls = [
        ['GET', `${base}/services/${bSvc.id}/availability?date=${D0}&clockMinutes=500`],
        ['POST', `${base}/services/${bSvc.id}/tickets`, { type: 'walk_in', date: D0, hourBlock: 540 }],
        ['GET', `${base}/tickets/${bTicketWalk.id}/status`],
        ['POST', `${base}/tickets/${bTicketWalk.id}/cancel`, {}],
        ['POST', `${base}/tickets/${bTicketBooked.id}/check-in`, {}],
      ];
      await forAll(calls, async ([m, p, body]) => { const r = await api(m, p, { body }); return r.status === 404 ? null : `${r.status}`; });
      assert.ok((await snapshot(B)) === before, 'B data changed');
    });
    it('public service / location lists show only the addressed tenant', async () => {
      const blob = JSON.stringify([(await get(`/api/public/tenant/${A.id}/services`)).json, (await get(`/api/public/tenant/${A.id}/locations`)).json, (await get(`/api/public/tenant/${A.id}/info`)).json]);
      for (const n of [bSvc.id, bSvc2.id, bLoc.id, bLoc2.id, B.businessName]) assert.ok(!blob.includes(n));
      assert.ok(blob.includes(aSvc.id) && blob.includes(A.businessName));
    });
    it('unknown (valid) tenant id -> 404 on every public tenant route', async () => {
      for (const p of ['info', 'locations', 'services', `services/${aSvc.id}/availability?date=${D0}`, `tickets/${aTicket.id}/status`]) {
        assert.equal((await get(`/api/public/tenant/${UUID0}/${p}`)).status, 404, p);
      }
    });
    it('public info / locations do not leak private fields (email, access codes, location code, ip hashes)', async () => {
      const blob = JSON.stringify([(await get(`/api/public/tenant/${B.id}/info`)).json, (await get(`/api/public/tenant/${B.id}/locations`)).json, (await get(`/api/public/tenant/${B.id}/services`)).json]);
      for (const bad of [B.email, B.tenant.access_code, 'access_code', 'staff_access_code', 'invoice', 'signup_country', 'ip_hash', B.locations[0].code, B.locations[0].staff_access_code]) {
        if (bad) assert.ok(!blob.includes(bad), `public payload leaks ${bad}`);
      }
    });
  });

  describe('authentication of /api/tenant', () => {
    const routes = [['GET', '/api/tenant/me'], ['GET', '/api/tenant/locations'], ['GET', '/api/tenant/services'], ['GET', `/api/tenant/tickets?date=${'2030-01-01'}`],
      ['GET', '/api/tenant/audit-log'], ['GET', '/api/tenant/licenses'], ['GET', '/api/tenant/staff'], ['POST', `/api/tenant/services/${UUID0}/call-next`], ['PATCH', '/api/tenant/me'], ['DELETE', '/api/tenant/me']];
    const check = async (token, want, headers) => forAll(routes, async ([m, p]) => {
      const r = await api(m, p, { token, headers, body: m === 'GET' || m === 'DELETE' ? undefined : {} });
      return Array.isArray(want) ? (want.includes(r.status) ? null : `${r.status}`) : (r.status === want ? null : `${r.status}`);
    });
    it('no token -> 401', async () => check(undefined, 401));
    it('garbage token -> 401', async () => { await check('not-a-jwt', 401); await check('a.b.c', 401); });
    it('Authorization without Bearer / empty bearer -> 401', async () => {
      await check(undefined, 401, { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` });
      await check(undefined, 401, { authorization: 'Bearer ' });
      await check(undefined, 401, { authorization: A.token });
    });
    it('expired token -> 401', async () => check(forgeJwt({ role: 'tenant_admin', tenantId: A.id, iat: nowSec() - 7200, exp: nowSec() - 3600 }), 401));
    it('token signed with another secret -> 401', async () => check(forgeJwt({ role: 'tenant_admin', tenantId: B.id, iat: nowSec(), exp: nowSec() + 600 }, { secret: 'wrong-secret' }), 401));
    it('alg=none token -> 401', async () => check(forgeJwt({ role: 'tenant_admin', tenantId: B.id, exp: nowSec() + 600 }, { alg: 'none' }), 401));
    it('payload tampered after signing (tenantId swapped to B) -> 401', async () => {
      const [h, , s] = A.token.split('.');
      const p = b64u(JSON.stringify({ ...decodeJwt(A.token), tenantId: B.id }));
      await check(`${h}.${p}.${s}`, 401);
    });
    it('system_admin token is not accepted on tenant routes (403)', async () => check(await systemToken(), 403));
    it('valid signature but unknown tenant -> 404 (and never someone else\'s data)', async () => {
      const tok = forgeJwt({ role: 'tenant_admin', tenantId: UUID0, iat: nowSec(), exp: nowSec() + 600 });
      await forAll(routes.filter(([m]) => m === 'GET'), async ([m, p]) => { const r = await get(p, { token: tok }); return r.status === 404 ? null : `${r.status}`; });
    });
    it('valid signature, role=tenant_admin, tenantId missing / malformed -> 4xx', async () => {
      for (const payload of [{ role: 'tenant_admin' }, { role: 'nobody', tenantId: A.id }]) {
        const r = await get('/api/tenant/me', { token: forgeJwt({ ...payload, iat: nowSec(), exp: nowSec() + 600 }) });
        assert.ok(is4xx(r.status), `${JSON.stringify(payload)} -> ${r.status}`);
      }
    });
  });

  describe('staff role restrictions', () => {
    let S, sTok, sStaff;
    before(async () => {
      S = await signup({ label: 'roles' }); sStaff = await addStaff(S); sTok = await staffLogin(sStaff.email);
      await goLive(S, S.services[0]);
    });
    it('staff token gets 403 on every adminOnly route (and nothing changes)', async () => {
      const svc = S.services[0].id, loc = S.locations[0].id;
      const routes = [
        ['GET', '/api/tenant/staff'], ['POST', '/api/tenant/staff', { firstName: 'x', lastName: 'y', email: 'api-test-x@example.com' }],
        ['PATCH', `/api/tenant/staff/${sStaff.id}`, { active: false }], ['DELETE', `/api/tenant/staff/${sStaff.id}`],
        ['PATCH', '/api/tenant/me', { businessName: 'pwned' }], ['DELETE', '/api/tenant/me'],
        ['POST', '/api/tenant/setup/dismiss', { task: 'x' }], ['POST', '/api/tenant/pay-now', { paymentMethod: 'card' }],
        ['POST', '/api/tenant/locations', { name: 'pwn' }], ['PATCH', `/api/tenant/locations/${loc}`, { name: 'pwn', archived: true }],
        ['POST', '/api/tenant/services', { name: 'pwn', locationId: loc }], ['PATCH', `/api/tenant/services/${svc}`, { archived: true }],
        ['POST', `/api/tenant/services/${svc}/licenses`, { planId: 'day', paymentMethod: 'card' }],
        ['PATCH', `/api/tenant/services/${svc}/licenses/${UUID0}`, { startDate: D0 }], ['POST', `/api/tenant/services/${svc}/licenses/${UUID0}/move`, { targetServiceId: svc }],
        ['POST', `/api/tenant/services/${svc}/licenses/${UUID0}/pay`, { paymentMethod: 'card' }], ['POST', `/api/tenant/services/${svc}/licenses/${UUID0}/refund`, {}],
        ['PUT', `/api/tenant/services/${svc}/daily-config`, { date: D0, hours: [] }], ['POST', `/api/tenant/services/${svc}/daily-config/copy`, { fromDate: D0, toDates: [] }],
        ['POST', `/api/tenant/services/${svc}/daily-config/clear-all`, {}], ['PATCH', `/api/tenant/tickets/${UUID0}`, { status: 'cancelled' }], ['DELETE', `/api/tenant/tickets/${UUID0}`],
      ];
      await forAll(routes, async ([m, p, body]) => { const r = await api(m, p, { token: sTok, body }); return r.status === 403 ? null : `${r.status} ${r.text.slice(0, 80)}`; });
      const me = (await get('/api/tenant/me', { token: S.token })).json.tenant;
      assert.equal(me.business_name, S.businessName);
      assert.equal((await get('/api/tenant/staff', { token: S.token })).json.staff.length, 1);
    });
    it('staff can use the operational routes', async () => {
      const svc = S.services[0].id;
      for (const [m, p] of [['GET', '/api/tenant/me'], ['GET', '/api/tenant/locations'], ['GET', '/api/tenant/services'], ['GET', `/api/tenant/tickets?date=${D0}`],
        ['GET', `/api/tenant/today?serviceId=${svc}`], ['GET', `/api/tenant/services/${svc}/availability?date=${D0}&clockMinutes=500`], ['GET', `/api/tenant/dashboard/stats?date=${D0}`]]) {
        assert.equal((await api(m, p, { token: sTok })).status, 200, p);
      }
      assert.equal((await post(`/api/tenant/services/${svc}/tickets`, { type: 'walk_in', date: D0, hourBlock: 540 }, { token: sTok })).status, 200);
      const r = await post(`/api/tenant/services/${svc}/call-next`, { date: D0, clockMinutes: 600, roomLabel: 'Room 1' }, { token: sTok });
      assert.equal(r.status, 200); assert.equal(r.json.ticket.called_by_staff_id, sStaff.id);
    });
    it('[D14] staff /me and read endpoints do not expose billing details (invoice PO/email, licence prices)', async () => {
      const me = (await get('/api/tenant/me', { token: sTok })).json.tenant;
      const leaks = ['invoice_po', 'invoice_email', 'access_code', 'payment_method'].filter((k) => k in me);
      const lic = await get('/api/tenant/licenses', { token: sTok });
      assert.deepEqual(leaks, [], `staff sees tenant fields ${leaks}`);
      assert.equal(lic.status, 403, 'staff can list every licence incl. prices / PO numbers');
    });
  });

  describe('self-service account deletion', () => {
    it('DELETE /me removes the account; the old token then fails; public pages 404', async () => {
      const T = await signup({ label: 'selfdel' });
      assert.equal((await del('/api/tenant/me', { token: T.token })).status, 200);
      assert.equal((await get('/api/tenant/me', { token: T.token })).status, 404);
      assert.equal((await get(`/api/public/tenant/${T.id}/info`)).status, 404);
      // CHANGED (account enumeration): a deleted account answers like any unknown address (200, no code) instead of 404.
      const rq = await post('/api/auth/admin/request-otp', { email: T.email }); assert.equal(rq.status, 200); assert.ok(!rq.json.demoOtp);
    });
  });
});

// =====================================================================================
// 3. LICENCES & OPENING HOURS
// =====================================================================================
describe('3. Licences & hours', () => {
  let T, D0, n = 0;
  const lic = async (svcId) => (await get(`/api/tenant/services/${svcId}/licenses`, { token: T.token })).json.licenses;
  const newService = async (name = `Svc${++n}`, extra = {}) => {
    const r = await post('/api/tenant/services', { name, locationId: T.locations[0].id, ...extra }, { token: T.token });
    assert.equal(r.status, 200, r.text);
    return r.json.service;
  };
  const buy = (svcId, body) => post(`/api/tenant/services/${svcId}/licenses`, body, { token: T.token });
  const sched = (svcId, licId, startDate) => patch(`/api/tenant/services/${svcId}/licenses/${licId}`, { startDate }, { token: T.token });
  const dc = async (svcId, from, to) => (await get(`/api/tenant/services/${svcId}/daily-config?from=${from}&to=${to}`, { token: T.token })).json.dailyConfig;
  const hoursOn = async (svcId, date) => (await dc(svcId, date, date))[0]?.hours;

  before(async () => {
    D0 = await today();
    T = await signup({ label: 'lic', locations: [{ name: 'L1' }], services: [{ name: 'Lic One', locationIndex: 0 }] });
  });

  describe('buying', () => {
    it('plans: day/week/month/year priced by the server, with the right length; created Available + paid by card', async () => {
      const s = await newService();
      const want = { day: [1, 25], week: [7, 100], month: [30, 200], year: [365, 600] };
      for (const [planId, [days, price]] of Object.entries(want)) {
        const r = await buy(s.id, { planId, paymentMethod: 'card', price: 0, plan_days: 999 });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.license.plan_days, days); assert.equal(Number(r.json.license.price), price, 'client-supplied price must be ignored');
        assert.equal(r.json.license.status, 'available'); assert.equal(r.json.license.paid, true);
        assert.equal(r.json.license.start_date, null); assert.equal(Number(r.json.charge.amount), price);
      }
    });
    it('custom plan: days x daily rate', async () => {
      const s = await newService();
      const r = await buy(s.id, { planId: 'custom', customDays: 5, paymentMethod: 'card' });
      assert.equal(r.status, 200); assert.equal(r.json.license.plan_days, 5); assert.equal(Number(r.json.license.price), 100);
    });
    it('unknown / missing / odd planId -> 400', async () => {
      const s = await newService();
      for (const planId of ['decade', '', undefined, null, 5, {}]) {
        const r = await buy(s.id, { planId, paymentMethod: 'card' });
        assert.equal(r.status, 400, `${JSON.stringify(planId)} -> ${r.status} ${r.text}`);
      }
    });
    it('[D15c] planId naming an Object.prototype member ("__proto__", "constructor", "toString") is a 400, not a 500', async () => {
      const s = await newService();
      await forAll(['__proto__', 'constructor', 'toString', 'hasOwnProperty'], async (planId) => {
        const r = await buy(s.id, { planId, paymentMethod: 'card' }); return r.status === 400 ? null : `${r.status}`;
      });
    });
    it('[D15b] planId must be a string (an array is not coerced into a plan)', async () => {
      const s = await newService();
      const r = await buy(s.id, { planId: ['day'], paymentMethod: 'card' });
      assert.equal(r.status, 400, `${r.status} plan_id stored as ${r.json?.license?.plan_id}`);
    });
    it('[D15] custom plan with absurd / non-integer customDays is a 4xx, not a 500', async () => {
      const s = await newService();
      await forAll([1e10, 2.5, -3, 'abc', 0, 99999999], async (customDays) => {
        const r = await buy(s.id, { planId: 'custom', customDays, paymentMethod: 'card' });
        if (r.status >= 500) return `${r.status}`;
        if (r.status === 200 && (r.json.license.plan_days > 3650 || r.json.license.plan_days < 1)) return `accepted plan_days=${r.json.license.plan_days}`;
        return null;
      });
    });
    it('invoice needs a PO; with PO it is stored and the licence is unpaid', async () => {
      const s = await newService();
      assert.equal((await buy(s.id, { planId: 'week', paymentMethod: 'invoice' })).status, 400);
      const r = await buy(s.id, { planId: 'week', paymentMethod: 'invoice', invoicePO: 'PO-123' });
      assert.equal(r.status, 200); assert.equal(r.json.license.paid, false); assert.equal(r.json.license.invoice_po, 'PO-123');
    });
    it('pay-later licence: unpaid, cannot be refunded until paid; pay by card works once; double pay -> 409', async () => {
      const s = await newService();
      const l = (await buy(s.id, { planId: 'day', paymentMethod: 'later' })).json.license;
      assert.equal(l.paid, false); assert.equal(l.payment_method, 'later');
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: T.token })).status, 409);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'bitcoin' }, { token: T.token })).status, 400);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'invoice' }, { token: T.token })).status, 400, 'invoice needs PO');
      const p = await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'card' }, { token: T.token });
      assert.equal(p.status, 200); assert.equal(p.json.license.paid, true);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/pay`, { paymentMethod: 'card' }, { token: T.token })).status, 409);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: T.token })).status, 200);
    });
    it('buying for an unknown / archived-other service -> 404', async () => {
      assert.equal((await buy(UUID0, { planId: 'day', paymentMethod: 'card' })).status, 404);
    });
  });

  describe('scheduling', () => {
    it('future start -> scheduled with derived end; start today -> active; dates are plain YYYY-MM-DD', async () => {
      const s = await newService();
      const w = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const r = await sched(s.id, w.id, addDays(D0, 10));
      assert.equal(r.status, 200); assert.equal(r.json.license.status, 'scheduled');
      assert.equal(r.json.license.start_date, addDays(D0, 10)); assert.equal(r.json.license.end_date, addDays(D0, 16));
      const d = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      const r2 = await sched(s.id, d.id, D0);
      assert.equal(r2.json.license.status, 'active'); assert.equal(r2.json.license.end_date, D0);
    });
    it('overlap -> 409 (incl. 1-day overlap); adjacent window is fine', async () => {
      const s = await newService();
      const a = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const b = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      assert.equal((await sched(s.id, a.id, addDays(D0, 20))).status, 200);          // 20..26
      assert.equal((await sched(s.id, b.id, addDays(D0, 14))).status, 409);           // 14..20 overlaps on day 20
      assert.equal((await sched(s.id, b.id, addDays(D0, 26))).status, 409);           // 26..32
      assert.equal((await sched(s.id, b.id, addDays(D0, 21))).status, 409);
      assert.equal((await sched(s.id, b.id, addDays(D0, 27))).status, 200);           // 27..33 adjacent
    });
    it('a window entirely in the past -> 409; missing startDate -> 400', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      assert.equal((await sched(s.id, l.id, addDays(D0, -30))).status, 409);
      assert.equal((await patch(`/api/tenant/services/${s.id}/licenses/${l.id}`, {}, { token: T.token })).status, 400);
    });
    it('[D16] malformed startDate -> 400, not 500', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      await forAll(['garbage', '2026-13-45', '2026-02-30', `${addDays(D0, 5)}T10:00:00`, 20261010, ['2026-10-10'], {}, '99999-01-01', '0000-00-00'], async (startDate) => {
        const r = await patch(`/api/tenant/services/${s.id}/licenses/${l.id}`, { startDate }, { token: T.token });
        return r.status === 400 ? null : `${r.status}`;
      });
    });
    it('an active licence cannot be rescheduled or unscheduled; an Available one cannot be unscheduled', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      assert.equal((await patch(`/api/tenant/services/${s.id}/licenses/${l.id}`, { unschedule: true }, { token: T.token })).status, 409);
      await sched(s.id, l.id, D0);
      assert.equal((await sched(s.id, l.id, addDays(D0, 30))).status, 409);
      assert.equal((await patch(`/api/tenant/services/${s.id}/licenses/${l.id}`, { unschedule: true }, { token: T.token })).status, 409);
    });
    it('moving a scheduled licence shifts its hours with it and clears the old dates', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const st = addDays(D0, 10); await sched(s.id, l.id, st);
      assert.equal((await putDay(T, s.id, st, { hours: [540, 570] })).status, 200);
      assert.equal((await putDay(T, s.id, addDays(st, 2), { hours: [600] })).status, 200);
      const r = await sched(s.id, l.id, addDays(D0, 20));
      assert.equal(r.status, 200); assert.equal(r.json.license.status, 'scheduled'); assert.equal(r.json.license.end_date, addDays(D0, 26));
      assert.deepEqual(await hoursOn(s.id, addDays(D0, 20)), [540, 570]);
      assert.deepEqual(await hoursOn(s.id, addDays(D0, 22)), [600]);
      assert.equal(await hoursOn(s.id, st), undefined, 'old day cleared');
      assert.equal(await hoursOn(s.id, addDays(st, 2)), undefined);
    });
    it('unscheduling a scheduled licence returns it to Available and clears hours', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const st = addDays(D0, 10); await sched(s.id, l.id, st); await putDay(T, s.id, st, { hours: [540] });
      const r = await patch(`/api/tenant/services/${s.id}/licenses/${l.id}`, { unschedule: true }, { token: T.token });
      assert.equal(r.status, 200); assert.equal(r.json.license.status, 'available'); assert.equal(r.json.license.start_date, null);
      assert.equal(await hoursOn(s.id, st), undefined);
      assert.equal((await putDay(T, s.id, st, { hours: [540] })).status, 409, 'no licence cover any more');
      assert.equal((await sched(s.id, l.id, st)).status, 200, 'can be scheduled again');
    });
  });

  describe('refund & move', () => {
    it('refund: Available and Scheduled ok (scheduled clears hours); Active / refunded -> 409', async () => {
      const s = await newService();
      const a = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      const sc = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const ac = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      const st = addDays(D0, 40); await sched(s.id, sc.id, st); await putDay(T, s.id, st, { hours: [540] });
      await sched(s.id, ac.id, D0);
      const R = (id) => post(`/api/tenant/services/${s.id}/licenses/${id}/refund`, {}, { token: T.token });
      assert.equal((await R(a.id)).json.license.status, 'refunded');
      assert.equal((await R(a.id)).status, 409, 'double refund');
      assert.equal((await R(sc.id)).json.license.status, 'refunded');
      assert.equal(await hoursOn(s.id, st), undefined);
      assert.equal((await R(ac.id)).status, 409, 'active');
      assert.equal((await R(UUID0)).status, 404);
    });
    it('a refunded licence cannot be scheduled, moved, or refunded again', async () => {
      const s = await newService(); const s2 = await newService();
      const l = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: T.token });
      assert.equal((await sched(s.id, l.id, addDays(D0, 5))).status, 409);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/move`, { targetServiceId: s2.id }, { token: T.token })).status, 409);
    });
    it('refund window: a licence bought more than 90 days ago cannot be refunded', needsDb, async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      sql(`update service_licenses set purchased_at = now() - interval '100 days' where id='${l.id}'`);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: T.token })).status, 409);
      sql(`update service_licenses set purchased_at = now() - interval '80 days' where id='${l.id}'`);
      assert.equal((await post(`/api/tenant/services/${s.id}/licenses/${l.id}/refund`, {}, { token: T.token })).status, 200);
    });
    it('move: Available licence moves to another own service; Scheduled/Active cannot; unknown target -> 404', async () => {
      const s = await newService(); const s2 = await newService();
      const a = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      const b = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      const M = (id, target) => post(`/api/tenant/services/${s.id}/licenses/${id}/move`, { targetServiceId: target }, { token: T.token });
      const r = await M(a.id, s2.id);
      assert.equal(r.status, 200); assert.equal(r.json.license.service_id, s2.id);
      assert.ok((await lic(s2.id)).some((x) => x.id === a.id)); assert.ok(!(await lic(s.id)).some((x) => x.id === a.id));
      await sched(s.id, b.id, addDays(D0, 50));
      assert.equal((await M(b.id, s2.id)).status, 409);
      assert.equal((await M(UUID0, s2.id)).status, 404);
      const c = (await buy(s.id, { planId: 'day', paymentMethod: 'card' })).json.license;
      assert.equal((await M(c.id, UUID0)).status, 404);
      assert.equal((await M(c.id, undefined)).status, 404);
    });
  });

  describe('licence with dates but no hours reverts to Available', () => {
    const aged = (id) => sql(`update service_licenses set scheduled_at = now() - interval '2 days' where id='${id}'`);
    it('same-day set-up is allowed; once the start date has arrived (set up on an earlier day) with no hours it reverts, dates cleared, audit entry', needsDb, async () => {
      const s = await newService();
      const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      assert.equal((await sched(s.id, l.id, D0)).json.license.status, 'active');
      assert.equal((await lic(s.id))[0].status, 'active', 'grace on the day it was scheduled');
      aged(l.id);
      const after = (await lic(s.id)).find((x) => x.id === l.id);
      assert.equal(after.status, 'available'); assert.equal(after.start_date, null); assert.equal(after.end_date, null); assert.equal(after.scheduled_at, null);
      assert.ok((await get('/api/tenant/audit-log', { token: T.token })).json.auditLog.some((e) => /returned to Available/.test(e.message)));
      // no longer public / joinable
      const pub = (await get(`${P(T)}/services`)).json.services;
      assert.ok(!pub.some((x) => x.id === s.id));
      assert.equal((await walkIn(T, s.id, D0)).status, 409);
      // and it can be scheduled again
      assert.equal((await sched(s.id, l.id, D0)).status, 200);
    });
    it('stays active when hours were set on any day in the window', needsDb, async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      await sched(s.id, l.id, D0); await putDay(T, s.id, addDays(D0, 3), { hours: [540] }); aged(l.id);
      assert.equal((await lic(s.id)).find((x) => x.id === l.id).status, 'active');
    });
    it('reverts when the only daily-config rows have empty hours', needsDb, async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      await sched(s.id, l.id, D0); await putDay(T, s.id, D0, { hours: [] }); aged(l.id);
      assert.equal((await lic(s.id)).find((x) => x.id === l.id).status, 'available');
    });
    it('a future Scheduled licence without hours is left alone until its start date', needsDb, async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      await sched(s.id, l.id, addDays(D0, 5)); aged(l.id);
      assert.equal((await lic(s.id)).find((x) => x.id === l.id).status, 'scheduled');
    });
    it('a Scheduled licence whose start date has arrived becomes Active (with hours); past end -> Expired', needsDb, async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license;
      await sched(s.id, l.id, addDays(D0, 5)); await putDay(T, s.id, addDays(D0, 5), { hours: [540] });
      sql(`update service_licenses set start_date='${D0}', end_date='${addDays(D0, 6)}', scheduled_at=now()-interval '3 days' where id='${l.id}'`);
      sql(`update service_daily_config set date='${D0}' where service_id='${s.id}'`);
      assert.equal((await lic(s.id)).find((x) => x.id === l.id).status, 'active');
      sql(`update service_licenses set start_date='${addDays(D0, -10)}', end_date='${addDays(D0, -4)}' where id='${l.id}'`);
      assert.equal((await lic(s.id)).find((x) => x.id === l.id).status, 'expired');
      assert.equal((await walkIn(T, s.id, D0)).status, 409, 'expired licence is not joinable');
    });
  });

  describe('daily-config (opening hours)', () => {
    let s, st;
    before(async () => {
      s = await newService(); const l = (await buy(s.id, { planId: 'month', paymentMethod: 'card' })).json.license;
      await sched(s.id, l.id, D0); st = D0;
    });
    const day = (i) => addDays(D0, i);
    it('valid hours are stored; date outside a licence / unknown service are refused', async () => {
      const r = await putDay(T, s.id, day(3), { hours: [540, 570, 600], staffCount: 4, bookingStaffCount: 2, walkInStaffCount: 2 });
      assert.equal(r.status, 200); assert.deepEqual(r.json.dailyConfig.hours, [540, 570, 600]);
      assert.equal(r.json.dailyConfig.staff_count, 4); assert.equal(r.json.dailyConfig.walkin_staff_count, 2);
      assert.equal((await putDay(T, s.id, day(90), { hours: [540] })).status, 409, 'outside licence');
      assert.equal((await putDay(T, s.id, day(-3), { hours: [540] })).status, 409, 'in the past');
      assert.equal((await putDay(T, UUID0, day(3), { hours: [540] })).status, 404);
      assert.equal((await put(`/api/tenant/services/${s.id}/daily-config`, { hours: [540] }, { token: T.token })).status, 409, 'date missing');
    });
    it('defaults and clamping of staff counts', async () => {
      const g = async (body) => (await put(`/api/tenant/services/${s.id}/daily-config`, { date: day(4), hours: [540], ...body }, { token: T.token })).json.dailyConfig;
      let c = await g({}); assert.deepEqual([c.staff_count, c.booking_staff_count, c.walkin_staff_count], [2, 1, 1]);
      c = await g({ staffCount: 2, bookingStaffCount: 5 }); assert.deepEqual([c.staff_count, c.booking_staff_count, c.walkin_staff_count], [2, 2, 0]);
      c = await g({ staffCount: 5, bookingStaffCount: 2, walkInStaffCount: 9 }); assert.deepEqual([c.staff_count, c.booking_staff_count, c.walkin_staff_count], [5, 2, 3]);
      c = await g({ staffCount: 3, bookingStaffCount: -4 }); assert.equal(c.booking_staff_count, 0);
      c = await g({ staffCount: 3, bookingStaffCount: 1, walkInStaffCount: -2 }); assert.equal(c.walkin_staff_count, 0);
    });
    it('[D17] hours must be 30-minute block starts within the day (0..1410), unique, <= 48 entries, and an array', async () => {
      const bad = [[45], [-30], [1440], [1500], [10.5], ['abc'], [null], [540, 540], Array.from({ length: 60 }, (_, i) => i * 30), '540', { 0: 540 }, 540, [Number.MAX_SAFE_INTEGER], [{}]];
      await forAll(bad.map((h) => ({ h })), async ({ h }) => {
        const r = await put(`/api/tenant/services/${s.id}/daily-config`, { date: day(5), hours: h, staffCount: 2 }, { token: T.token });
        return r.status === 400 ? null : `${r.status} stored=${JSON.stringify(r.json?.dailyConfig?.hours)?.slice(0, 40)}`;
      });
    });
    it('[D18] staff counts must be non-negative integers within a sane bound; never a 500', async () => {
      const bad = [{ staffCount: -1 }, { staffCount: 1.5 }, { staffCount: 'abc' }, { staffCount: 1e10 }, { staffCount: 100000 }, { staffCount: [] }, { staffCount: {} },
        { staffCount: 2, bookingStaffCount: 'x' }, { staffCount: 2, bookingStaffCount: 0.5 }, { staffCount: 3, walkInStaffCount: 1.5 }, { staffCount: 3, walkInStaffCount: 'x' }];
      await forAll(bad, async (b) => {
        const r = await put(`/api/tenant/services/${s.id}/daily-config`, { date: day(6), hours: [540], ...b }, { token: T.token });
        return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 60)}`;
      });
    });
    it('empty hours = closed day', async () => {
      assert.equal((await putDay(T, s.id, day(7), { hours: [] })).status, 200);
      const a = (await get(`${P(T)}/services/${s.id}/availability?date=${day(7)}&clockMinutes=0`)).json;
      assert.equal(a.open, false); assert.equal(a.reason, 'closed');
    });
    it('live day (today): reducing staff is blocked once there is a ticket; adding staff ok; hours with tickets / already started cannot be removed', async () => {
      const ls = await newService(); const l = (await buy(ls.id, { planId: 'week', paymentMethod: 'card' })).json.license; await sched(ls.id, l.id, D0);
      assert.equal((await putDay(T, ls.id, D0, { hours: [0, 30, 540, 570], staffCount: 3, bookingStaffCount: 1, walkInStaffCount: 2 })).status, 200);
      assert.equal((await putDay(T, ls.id, D0, { hours: [0, 30, 540, 570], staffCount: 2, bookingStaffCount: 1, walkInStaffCount: 1 })).status, 200, 'reducing while empty is fine');
      assert.equal((await walkIn(T, ls.id, D0, 540)).status, 200);
      const same = { hours: [0, 30, 540, 570], bookingStaffCount: 1, walkInStaffCount: 1 };
      assert.equal((await putDay(T, ls.id, D0, { ...same, staffCount: 1, bookingStaffCount: 1, walkInStaffCount: 0 })).status, 409, 'reduce with a waiting walk-in');
      assert.equal((await putDay(T, ls.id, D0, { ...same, staffCount: 4 })).status, 200, 'increase');
      assert.equal((await putDay(T, ls.id, D0, { ...same, staffCount: 4, hours: [0, 30, 570] })).status, 409, 'block 540 holds a ticket');
      assert.equal((await putDay(T, ls.id, D0, { ...same, staffCount: 4, hours: [30, 540, 570], nowMinutes: 300 })).status, 409, 'block 0 already started');
      assert.equal((await putDay(T, ls.id, D0, { ...same, staffCount: 4, hours: [0, 30, 540, 570, 600], nowMinutes: 300 })).status, 200, 'adding a future block is ok');
    });
    it('copy: copies to licensed future days; skips unlicensed days and today; reports counts', async () => {
      await putDay(T, s.id, day(8), { hours: [600, 630], staffCount: 6, bookingStaffCount: 3, walkInStaffCount: 3 });
      const r = await post(`/api/tenant/services/${s.id}/daily-config/copy`, { fromDate: day(8), toDates: [day(9), day(10), day(200), D0] }, { token: T.token });
      assert.equal(r.status, 200); assert.equal(r.json.count, 2); assert.equal(r.json.skipped, 2);
      assert.deepEqual(await hoursOn(s.id, day(10)), [600, 630]);
      const c = (await dc(s.id, day(9), day(9)))[0]; assert.deepEqual([c.staff_count, c.booking_staff_count, c.walkin_staff_count], [6, 3, 3]);
    });
    it('[D19] copy rejects malformed input with 4xx (not 500)', async () => {
      const cases = [{ fromDate: 'garbage', toDates: [day(9)] }, { fromDate: day(8), toDates: 5 }, { fromDate: day(8), toDates: { a: 1 } }, { fromDate: ['x'], toDates: [] }, { toDates: [day(9)] },
        { fromDate: day(8), toDates: [day(9) + "'; select 1;--"] }, { fromDate: day(8), toDates: 'abcdefg' }];
      await forAll(cases, async (b) => { const r = await post(`/api/tenant/services/${s.id}/daily-config/copy`, b, { token: T.token }); return is4xx(r.status) ? null : `${r.status} ${r.text.slice(0, 60)}`; });
    });
    it('clear-all empties every future day in the licence windows but never today', async () => {
      await putDay(T, s.id, D0, { hours: [540] });
      const r = await post(`/api/tenant/services/${s.id}/daily-config/clear-all`, {}, { token: T.token });
      assert.equal(r.status, 200); assert.ok(r.json.count > 0);
      const rows = await dc(s.id, D0, day(29));
      assert.deepEqual(rows.find((x) => x.date === D0).hours, [540], 'today untouched');
      assert.ok(rows.filter((x) => x.date > D0).every((x) => x.hours.length === 0));
    });
    it('GET daily-config returns the licence windows', async () => {
      const r = (await get(`/api/tenant/services/${s.id}/daily-config?from=${D0}&to=${day(2)}`, { token: T.token })).json;
      assert.equal(r.windows.length, 1); assert.equal(r.windows[0].start, D0);
    });
  });

  describe('services without licence / hours are not joinable', () => {
    it('no licence at all: hidden from public list, availability closed, join -> 409', async () => {
      const s = await newService();
      assert.ok(!(await get(`${P(T)}/services`)).json.services.some((x) => x.id === s.id));
      const a = (await get(`${P(T)}/services/${s.id}/availability?date=${D0}&clockMinutes=600`)).json;
      assert.deepEqual([a.open, a.reason], [false, 'outside_license_window']);
      assert.equal((await walkIn(T, s.id, D0)).status, 409);
      assert.equal((await booked(T, s.id, D0)).status, 409);
    });
    it('Available (unscheduled) licence only: still hidden and not joinable', async () => {
      const s = await newService(); await buy(s.id, { planId: 'month', paymentMethod: 'card' });
      assert.ok(!(await get(`${P(T)}/services`)).json.services.some((x) => x.id === s.id));
      assert.equal((await walkIn(T, s.id, D0)).status, 409);
    });
    it('licensed date outside the window -> 409; archived service -> 409 and hidden', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license; await sched(s.id, l.id, D0); await putDay(T, s.id, D0);
      assert.equal((await walkIn(T, s.id, addDays(D0, 8))).status, 409);
      assert.ok((await get(`${P(T)}/services`)).json.services.some((x) => x.id === s.id));
      assert.equal((await patch(`/api/tenant/services/${s.id}`, { archived: true }, { token: T.token })).status, 200);
      assert.ok(!(await get(`${P(T)}/services`)).json.services.some((x) => x.id === s.id));
      assert.equal((await walkIn(T, s.id, D0)).status, 409);
      assert.equal((await get(`${P(T)}/services/${s.id}/availability?date=${D0}&clockMinutes=600`)).json.open, false);
    });
    it('[D20] licensed service but a day with no opening hours: not joinable (availability says closed)', async () => {
      const s = await newService(); const l = (await buy(s.id, { planId: 'week', paymentMethod: 'card' })).json.license; await sched(s.id, l.id, D0);
      await putDay(T, s.id, D0, { hours: [540] }); // keeps licence alive
      const d = addDays(D0, 2); // inside the licence, no config row at all
      assert.equal((await get(`${P(T)}/services/${s.id}/availability?date=${d}&clockMinutes=600`)).json.reason, 'closed');
      const r1 = await walkIn(T, s.id, d); const r2 = await booked(T, s.id, d);
      await putDay(T, s.id, addDays(D0, 3), { hours: [] });
      const r3 = await walkIn(T, s.id, addDays(D0, 3));
      assert.ok([r1, r2, r3].every((r) => is4xx(r.status)), `join on a closed day -> ${[r1, r2, r3].map((r) => r.status)}`);
    });
  });
});

// =====================================================================================
// 4. PATIENT JOURNEY (public API)
// =====================================================================================
describe('4. Patient journey (public API)', () => {
  let P_, D0, hy, qs, ap, loc2;
  const HOURS = [540, 570, 600, 630];
  // (`clock` moves the SERVER clock for the call; the clockMinutes also sent is ignored by the server, as a lying client's would be)
  const avail = async (svc, date, clock) => atMinutes(clock, async () => (await get(`${P(P_)}/services/${svc.id}/availability?date=${date}&clockMinutes=${clock}`)).json);
  const day = (i) => addDays(D0, i);
  const call = (id, room = 'Room 1') => post(`/api/tenant/tickets/${id}/call`, { roomLabel: room }, { token: P_.token });
  const devId = () => `dev${rnd()}${rnd()}${rnd()}`;

  before(async () => {
    D0 = await today();
    P_ = await signup({ label: 'pat', locations: [{ name: 'Main' }, { name: 'Second' }],
      services: [{ name: 'Dental Care', locationIndex: 0, mode: 'hybrid', slotMinutes: 15 }, { name: 'Quick Queue', locationIndex: 1, mode: 'queue', slotMinutes: 15 }, { name: 'Booked Visits', locationIndex: 0, mode: 'appointment', slotMinutes: 15 }] });
    [hy, qs, ap] = P_.services; loc2 = P_.locations.find((l) => l.name === 'Second');
    // Most days have plenty of capacity (join rules are enforced, so tests that only need *a* ticket must not run out of
    // places); the days used by the availability and capacity tests below are set to a known small budget.
    await goLive(P_, hy, { days: 12, hours: HOURS, staffCount: 20, bookingStaffCount: 10, walkInStaffCount: 10 });
    await goLive(P_, qs, { days: 5, hours: HOURS, staffCount: 10, bookingStaffCount: 0, walkInStaffCount: 10 });
    await goLive(P_, ap, { days: 3, hours: HOURS, staffCount: 1, bookingStaffCount: 1, walkInStaffCount: 0 });
    for (const i of [0, 1, 2]) {
      const r = await putDay(P_, hy.id, day(i), { hours: HOURS, staffCount: 3, bookingStaffCount: 2, walkInStaffCount: 1 });
      assert.equal(r.status, 200, r.text);
    }
  });

  describe('read-only public endpoints', () => {
    it('info exposes only business name, status, website and the account\'s time zone / currency', async () => {
      const r = await get(`${P(P_)}/info`);
      assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['businessName', 'currency', 'defaultTimezone', 'status', 'websiteUrl']);
      assert.equal(r.json.businessName, P_.businessName);
    });
    it('locations lists active locations without the on-site code', async () => {
      const r = (await get(`${P(P_)}/locations`)).json.locations;
      assert.equal(r.length, 2); assert.ok(r.every((l) => l.id && l.name && !('code' in l) && !('staff_access_code' in l)));
    });
    it('services lists licensed services with id/name/location/mode', async () => {
      const r = (await get(`${P(P_)}/services`)).json.services;
      assert.deepEqual(r.map((s) => s.name), ['Booked Visits', 'Dental Care', 'Quick Queue']);
      assert.ok(r.every((s) => s.id && s.location_id && s.mode));
    });
    it('hybrid availability: walk-in budget and bookable slots from "now" onward', async () => {
      const a = await avail(hy, D0, 500);
      assert.equal(a.open, true); assert.deepEqual(a.walkIn, { available: true, remaining: 2, block: 540 });
      assert.deepEqual(a.bookableSlots.slice(0, 4), [540, 555, 570, 585]); assert.equal(a.bookableSlots.length, 8);
      const b = await avail(hy, D0, 556);
      assert.deepEqual(b.bookableSlots.slice(0, 2), [570, 585]); assert.equal(b.walkIn.block, 540);
    });
    it('queue-mode has no bookable slots; appointment-mode has no walk-in capacity', async () => {
      const q = await avail(qs, D0, 500); assert.equal(q.open, true); assert.deepEqual(q.bookableSlots, []); assert.equal(q.walkIn.available, true);
      const a = await avail(ap, D0, 500); assert.equal(a.open, true); assert.equal(a.walkIn.available, false); assert.equal(a.bookableSlots.length, 8);
    });
    it('[D21] slots for a future date are not filtered by the caller\'s time of day', async () => {
      const a = await avail(hy, day(1), 1300); assert.equal(a.open, true); assert.equal(a.bookableSlots[0], 540);
    });
    it('after hours: today past the last block + 30 minutes is closed; one minute before is still open', async () => {
      const closed = async (m) => { const a = await avail(hy, D0, m); return { open: a.open, reason: a.reason }; };
      assert.deepEqual(await closed(660), { open: false, reason: 'closed' });
      assert.deepEqual(await closed(1400), { open: false, reason: 'closed' });
      const a = await avail(hy, D0, 659); assert.equal(a.open, true);
      assert.equal((await avail(hy, D0, 100)).open, true, 'before opening is not closed');
    });
    it('availability / join on a date with no or malformed parameters never errors', async () => {
      assert.equal((await get(`${P(P_)}/services/${hy.id}/availability`)).status, 200);
      assert.equal((await get(`${P(P_)}/services/${hy.id}/availability?date=${D0}`)).status, 200);
      assert.equal((await get(`${P(P_)}/services/${hy.id}/availability?date=${D0}&clockMinutes=abc`)).status, 200);
    });
    it('unknown service -> 404', async () => {
      assert.equal((await get(`${P(P_)}/services/${UUID0}/availability?date=${D0}&clockMinutes=1`)).status, 404);
      assert.equal((await walkIn(P_, UUID0, D0)).status, 404);
    });
    it('public location-code lookup resolves a code case-insensitively and 404s on unknown', async () => {
      const code = P_.locations[0].code;
      const r = await get(`/api/public/code/${code.toLowerCase()}`);
      assert.equal(r.status, 200); assert.equal(r.json.tenantId, P_.id); assert.equal(r.json.locationId, P_.locations[0].id);
      assert.equal((await get('/api/public/code/QB-ZZZZZZ')).status, 404);
      assert.equal((await get(`/api/public/code/${encodeURIComponent("' or 1=1 --")}`)).status, 404);
    });
  });

  describe('joining', () => {
    it('walk-in: returns a waiting ticket, a public token and queue info', async () => {
      const r = await walkIn(P_, hy.id, day(5), 540);
      assert.equal(r.status, 200, r.text);
      const t = r.json.ticket;
      assert.equal(t.status, 'waiting'); assert.equal(t.type, 'walk_in'); assert.equal(t.visit_date, day(5)); assert.equal(t.hour_block, 540);
      assert.equal(t.tenant_id, P_.id); assert.equal(t.service_id, hy.id); assert.equal(t.location_id, hy.location_id);
      assert.match(r.json.publicToken, /^[A-Za-z0-9_-]{22,64}$/);
      assert.equal(r.json.queue.position, 1);
      assert.ok(!('device_hash' in t) && !('ip_hash' in t));
    });
    it('booked: returns a booked ticket with its slot', async () => {
      const r = await booked(P_, hy.id, day(5), 555);
      assert.equal(r.status, 200); assert.equal(r.json.ticket.status, 'booked'); assert.equal(r.json.ticket.slot_time, 555); assert.equal(r.json.queue, null);
    });
    it('ticket number: <INITIALS>-NNN, sequential per service per day, restarting each day', async () => {
      const a = await walkIn(P_, hy.id, day(6), 540); const b = await walkIn(P_, hy.id, day(6), 540); const c = await walkIn(P_, hy.id, day(7), 540);
      assert.equal(a.json.ticket.ticket_number, 'DC-001'); assert.equal(b.json.ticket.ticket_number, 'DC-002'); assert.equal(c.json.ticket.ticket_number, 'DC-001');
      assert.match((await walkIn(P_, qs.id, day(1), 540)).json.ticket.ticket_number, /^QQ-\d{3}$/);
    });
    it('[D22] ticket numbers are unique even for simultaneous joins', async () => {
      const d = day(8); await putDay(P_, hy.id, d, { hours: HOURS, staffCount: 20, bookingStaffCount: 5, walkInStaffCount: 15 });
      const rs = await Promise.all(Array.from({ length: 10 }, () => walkIn(P_, hy.id, d, 540)));
      assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
      const nums = rs.map((r) => r.json.ticket.ticket_number);
      assert.equal(new Set(nums).size, nums.length, `duplicate numbers: ${nums.sort().join(' ')}`);
    });
    it('[D22b] a ticket number is never reused on the same service/day after a ticket is deleted', async () => {
      const d = day(9); await putDay(P_, hy.id, d, { hours: HOURS, staffCount: 20, bookingStaffCount: 5, walkInStaffCount: 15 });
      const a = (await walkIn(P_, hy.id, d, 540)).json.ticket; const b = (await walkIn(P_, hy.id, d, 540)).json.ticket;
      await del(`/api/tenant/tickets/${a.id}`, { token: P_.token });
      const c = (await walkIn(P_, hy.id, d, 540)).json.ticket;
      assert.notEqual(c.ticket_number, b.ticket_number, `${c.ticket_number} issued twice`);
    });
    it('[D23] walk-in capacity per 30-minute block is enforced (budget 2 -> third is refused)', async () => {
      const d = day(1);
      const rs = []; for (let i = 0; i < 3; i++) rs.push(await walkIn(P_, hy.id, d, 570));
      assert.deepEqual(rs.slice(0, 2).map((r) => r.status), [200, 200]);
      const full = (await avail(hy, d, 575)).walkIn;
      assert.deepEqual([full.available, full.remaining, full.block], [false, 0, 570], 'availability reports the block as full');
      assert.equal(rs[2].status, 409, `third walk-in into a full block was accepted (${rs[2].status})`);
    });
    it('[D24] booking capacity per slot is enforced (2 staff -> third booking of the same slot is refused)', async () => {
      const d = day(2);
      const rs = []; for (let i = 0; i < 3; i++) rs.push(await booked(P_, hy.id, d, 540));
      assert.deepEqual(rs.slice(0, 2).map((r) => r.status), [200, 200]);
      assert.ok(!(await avail(hy, d, 0)).bookableSlots.includes(540), 'availability hides the full slot');
      assert.equal(rs[2].status, 409, `third booking of a full slot was accepted (${rs[2].status}) - double booking`);
    });
    it('a cancelled booking frees its slot', async () => {
      const d = day(2); const a = await booked(P_, ap.id, d, 540);
      assert.ok(!(await avail(ap, d, 0)).bookableSlots.includes(540));
      await post(`/api/public/ticket/${a.json.publicToken}/leave`, {});
      assert.ok((await avail(ap, d, 0)).bookableSlots.includes(540));
      assert.equal((await booked(P_, ap.id, d, 540)).status, 200);
    });
    it('[D25] booking must be for an offered slot (inside opening hours, on the slot grid)', async () => {
      const d = day(10);
      await forAll([541, 300, 5000, -15, 650, 660], async (slotTime) => {
        const r = await booked(P_, hy.id, d, slotTime); return r.status === 409 || r.status === 400 ? null : `${r.status}`;
      });
    });
    it('[D26] join validates type / slotTime / hourBlock / date: 4xx, never 500', async () => {
      const d = day(10);
      const bad = [{ type: 'foo', date: d }, { date: d }, { type: null, date: d }, { type: 'booked', date: d }, { type: 'booked', date: d, slotTime: 'abc' }, { type: 'booked', date: d, slotTime: 1.5 },
        { type: 'walk_in', date: d, hourBlock: 'abc' }, { type: 'walk_in', date: d, hourBlock: 1e12 }, { type: ['walk_in'], date: d }, { type: 'walk_in', date: [d] }, { type: 'walk_in', date: `${d}x` },
        { type: 'walk_in', date: `${d}'; select pg_sleep(0)--`, hourBlock: 540 }, { type: 'walk_in', date: '2026-02-31' }, {}];
      await forAll(bad, async (b) => { const r = await join(P_, hy.id, b); return is4xx(r.status) ? null : `${r.status} ${r.text.slice(0, 70)}`; });
    });
    it('[D26b] a walk-in must carry an hourBlock that is one of the day\'s opening blocks; a booking must not be a walk-in', async () => {
      const d = day(10);
      for (const hb of [undefined, 123, 5000]) {
        const r = await join(P_, hy.id, { type: 'walk_in', date: d, ...(hb === undefined ? {} : { hourBlock: hb }) });
        assert.ok(is4xx(r.status), `hourBlock ${hb} -> ${r.status}`);
      }
    });
    it('[D27] service mode is respected: no bookings on a queue-only service, no walk-ins on an appointment-only service', async () => {
      const r1 = await booked(P_, qs.id, day(1), 540); const r2 = await walkIn(P_, ap.id, day(1), 540);
      assert.ok(is4xx(r1.status), `booking on queue service -> ${r1.status}`);
      assert.ok(is4xx(r2.status), `walk-in on appointment service -> ${r2.status}`);
    });
    it('per-device limit: 2 active tickets per device/service/day, then 429; another device ok; leaving frees a place', async () => {
      const d = day(3), dev = devId(), mk = (id) => walkIn(P_, qs.id, d, 540, { deviceId: id });
      const a = await mk(dev), b = await mk(dev); assert.deepEqual([a.status, b.status], [200, 200]);
      const c = await mk(dev); assert.equal(c.status, 429); assert.equal(c.json.reason, 'too_many_device');
      assert.equal((await mk(devId())).status, 200);
      await post(`/api/public/ticket/${a.json.publicToken}/leave`, {});
      assert.equal((await mk(dev)).status, 200);
    });
    it('per-device limit does not apply across services / days', async () => {
      const dev = devId();
      for (const [svc, d] of [[qs, day(1)], [qs, day(2)], [hy, day(4)]]) { assert.equal((await walkIn(P_, svc.id, d, 540, { deviceId: dev })).status, 200); assert.equal((await walkIn(P_, svc.id, d, 540, { deviceId: dev })).status, 200); }
    });
    it('per-IP limit: 6 active tickets per IP/service/day, then 429 too_many_ip', async () => {
      const d = day(11); await putDay(P_, hy.id, d, { hours: HOURS, staffCount: 20, bookingStaffCount: 5, walkInStaffCount: 15 });
      const ip = randIp();
      for (let i = 0; i < 6; i++) assert.equal((await walkIn(P_, hy.id, d, 540, { deviceId: devId() }, ip)).status, 200, `ticket ${i + 1}`);
      const r = await walkIn(P_, hy.id, d, 540, { deviceId: devId() }, ip);
      assert.equal(r.status, 429); assert.equal(r.json.reason, 'too_many_ip');
      assert.equal((await walkIn(P_, hy.id, d, 540, { deviceId: devId() }, randIp())).status, 200, 'other IP unaffected');
    });
    it('a malformed deviceId is ignored (no 500)', async () => {
      for (const deviceId of ['short', '', 5, ['x'], { a: 1 }, "x'; drop table tickets;--xxxxxxxxxxxx"]) {
        const r = await walkIn(P_, qs.id, day(2), 540, { deviceId }); assert.ok(r.status < 500, `${JSON.stringify(deviceId)} -> ${r.status}`);
      }
    });
  });

  describe('public ticket token API', () => {
    let w, bk, wTok, bTok;
    const tk = (tok) => get(`/api/public/ticket/${tok}`);
    before(async () => {
      const d = D0;
      w = (await walkIn(P_, hy.id, d, 540)).json; bk = (await booked(P_, hy.id, d, 585)).json; wTok = w.publicToken; bTok = bk.publicToken;
    });
    it('GET: walk-in shows state/number/position without personal data or internal ids', async () => {
      const r = await tk(wTok);
      assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.json.state, 'waiting'); assert.equal(r.json.ticketNumber, w.ticket.ticket_number); assert.equal(r.json.type, 'walk_in');
      assert.equal(r.json.serviceName, 'Dental Care'); assert.equal(r.json.locationName, 'Main'); assert.equal(r.json.businessName, P_.businessName);
      assert.equal(r.json.slotTime, null); assert.equal(r.json.calledRoom, null);
      assert.equal(typeof r.json.peopleAhead, 'number');
      const blob = r.text;
      for (const bad of [P_.id, w.ticket.id, hy.id, 'tenant_id', 'ip_hash', 'device_hash', P_.email]) assert.ok(!blob.includes(bad), `leaks ${bad}`);
    });
    it('GET: booked shows slotTime and no queue position', async () => {
      const r = (await tk(bTok)).json; assert.equal(r.type, 'booked'); assert.equal(r.slotTime, 585); assert.equal(r.peopleAhead, null); assert.equal(r.arrived, false);
    });
    it('peopleAhead counts earlier waiting walk-ins and drops when they are called', async () => {
      const d = day(6);
      const a = (await walkIn(P_, hy.id, d, 540)).json, b = (await walkIn(P_, hy.id, d, 540)).json;
      assert.equal((await tk(a.publicToken)).json.peopleAhead, (await tk(a.publicToken)).json.peopleAhead);
      const before = (await tk(b.publicToken)).json.peopleAhead;
      assert.equal(before, (await tk(a.publicToken)).json.peopleAhead + 1);
      await call(a.ticket.id);
      assert.equal((await tk(b.publicToken)).json.peopleAhead, before - 1);
    });
    it('unknown / malformed tokens -> 404 with state unknown (no 500)', async () => {
      await forAll(['x', 'a'.repeat(21), 'a'.repeat(22), 'a'.repeat(65), UUID0, w.ticket.id, w.ticket.ticket_number, encodeURIComponent("' or '1'='1"), '..%2f..%2fetc', '%00'], async (tok) => {
        const r = await tk(tok); return r.status === 404 ? null : `${r.status}`;
      });
    });
    it('a ticket id / number / sequential guess does not open anyone\'s ticket', async () => {
      assert.equal((await tk(w.ticket.id)).status, 404);
      assert.equal((await get(`${P(P_)}/tickets`)).status, 404, 'no public listing');
      const mutated = wTok.slice(0, -1) + (wTok.endsWith('A') ? 'B' : 'A');
      assert.equal((await tk(mutated)).status, 404);
    });
    it('tokens are high-entropy and unique', async () => {
      const toks = new Set([wTok, bTok]); assert.equal(toks.size, 2); assert.ok(wTok.length >= 22);
    });
    it('check-in: only booked tickets; idempotent; staff see arrived_at; not after cancel', async () => {
      assert.equal((await post(`/api/public/ticket/${wTok}/check-in`, {})).status, 409, 'walk-in');
      assert.equal((await post(`/api/public/ticket/${bTok}/check-in`, {})).status, 200);
      assert.equal((await post(`/api/public/ticket/${bTok}/check-in`, {})).status, 200);
      assert.equal((await tk(bTok)).json.arrived, true);
      const row = (await get(`/api/tenant/tickets?date=${D0}`, { token: P_.token })).json.tickets.find((x) => x.id === bk.ticket.id);
      assert.ok(row.arrived_at);
      const x = (await booked(P_, hy.id, D0, 600)).json; await post(`/api/public/ticket/${x.publicToken}/leave`, {});
      assert.equal((await post(`/api/public/ticket/${x.publicToken}/check-in`, {})).status, 409);
    });
    it('legacy by-id check-in behaves the same (booked only)', async () => {
      const x = (await booked(P_, hy.id, day(7), 540)).json, y = (await walkIn(P_, hy.id, day(7), 540)).json;
      assert.equal((await post(`${P(P_)}/tickets/${x.ticket.id}/check-in`, {})).status, 200);
      assert.equal((await post(`${P(P_)}/tickets/${y.ticket.id}/check-in`, {})).status, 409);
    });
    it('leave: cancels a waiting ticket, is idempotent, shows cancelled and frees the queue', async () => {
      const x = (await walkIn(P_, hy.id, day(7), 540)).json;
      const r = await post(`/api/public/ticket/${x.publicToken}/leave`, {});
      assert.equal(r.status, 200); assert.equal(r.json.state, 'cancelled');
      assert.equal((await post(`/api/public/ticket/${x.publicToken}/leave`, {})).json.state, 'cancelled');
      assert.equal((await tk(x.publicToken)).json.state, 'cancelled');
      const st = (await get(`/api/tenant/tickets?date=${day(7)}`, { token: P_.token })).json.tickets.find((t) => t.id === x.ticket.id);
      assert.equal(st.status, 'cancelled');
    });
    it('leave: refused (409) once called, completed or no-show; called shows room', async () => {
      const x = (await walkIn(P_, hy.id, day(7), 540)).json; await call(x.ticket.id, 'Room 7');
      const s = (await tk(x.publicToken)).json; assert.equal(s.state, 'called'); assert.equal(s.calledRoom, 'Room 7');
      assert.equal((await post(`/api/public/ticket/${x.publicToken}/leave`, {})).status, 409);
      await post(`/api/tenant/tickets/${x.ticket.id}/close`, {}, { token: P_.token });
      assert.equal((await tk(x.publicToken)).json.state, 'closed');
      assert.equal((await post(`/api/public/ticket/${x.publicToken}/leave`, {})).status, 409);
      const y = (await walkIn(P_, hy.id, day(7), 540)).json; await call(y.ticket.id); await post(`/api/tenant/tickets/${y.ticket.id}/no-show`, {}, { token: P_.token });
      assert.equal((await tk(y.publicToken)).json.state, 'closed'); assert.equal((await post(`/api/public/ticket/${y.publicToken}/leave`, {})).status, 409);
    });
    it('a ticket from a past day is reported expired and cannot be left', needsDb, async () => {
      const x = (await walkIn(P_, hy.id, day(7), 540)).json;
      sql(`update tickets set visit_date = '${addDays(D0, -2)}' where id='${x.ticket.id}'`);
      assert.equal((await tk(x.publicToken)).json.state, 'expired');
      const r = await post(`/api/public/ticket/${x.publicToken}/leave`, {}); assert.equal(r.status, 409); assert.equal(r.json.state, 'expired');
    });
    it('whatsapp-intent records the request without delivering anything', async () => {
      assert.equal((await tk(wTok)).json.whatsappUpdatesRequested, false);
      const r = await post(`/api/public/ticket/${wTok}/whatsapp-intent`, {});
      assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, delivered: false });
      assert.equal((await tk(wTok)).json.whatsappUpdatesRequested, true);
      assert.equal((await post(`/api/public/ticket/${'z'.repeat(30)}/whatsapp-intent`, {})).status, 404);
    });
    it('legacy status endpoint: status / number / call message after being called; cancel allowed only while pending', async () => {
      const x = (await walkIn(P_, hy.id, day(7), 540)).json;
      let s = (await get(`${P(P_)}/tickets/${x.ticket.id}/status`)).json; assert.equal(s.status, 'waiting'); assert.equal(s.message, null);
      await call(x.ticket.id, 'Room 9');
      s = (await get(`${P(P_)}/tickets/${x.ticket.id}/status`)).json; assert.equal(s.status, 'serving'); assert.match(s.message, /Room 9/);
      assert.equal((await post(`${P(P_)}/tickets/${x.ticket.id}/cancel`, {})).status, 409);
      const y = (await walkIn(P_, hy.id, day(7), 540)).json;
      assert.equal((await post(`${P(P_)}/tickets/${y.ticket.id}/cancel`, {})).status, 200);
    });
    it('the rate limiter on token reads answers 429 with Retry-After (90 req/min/IP)', async () => {
      const ip = randIp(); let last;
      for (let i = 0; i < 95; i++) { last = await get(`/api/public/ticket/${wTok}`, { ip }); if (last.status === 429) break; }
      assert.equal(last.status, 429); assert.ok(last.headers.get('retry-after'));
    });
  });

  describe('closed / paused / disabled', () => {
    let Q;
    before(async () => {
      Q = await signup({ label: 'pause', locations: [{ name: 'Q1' }, { name: 'Q2' }], services: [{ name: 'Queue Only', locationIndex: 0, mode: 'queue' }, { name: 'Other Svc', locationIndex: 1, mode: 'hybrid' }] });
      await goLive(Q, Q.services[0], { days: 2, hours: HOURS, staffCount: 2, bookingStaffCount: 0, walkInStaffCount: 2 });
      await goLive(Q, Q.services[1], { days: 2, hours: HOURS });
    });
    it('queue_paused: availability reports paused', async () => {
      const svc = Q.services[0];
      assert.equal((await patch(`/api/tenant/services/${svc.id}`, { queuePaused: true }, { token: Q.token })).json.service.queue_paused, true);
      const a = (await get(`/api/public/tenant/${Q.id}/services/${svc.id}/availability?date=${D0}&clockMinutes=600`)).json;
      assert.deepEqual([a.open, a.reason], [false, 'paused']);
    });
    it('[D28] a paused queue refuses new walk-ins', async () => {
      const svc = Q.services[0];
      const r = await walkIn(Q, svc.id, D0, 600);
      assert.ok(is4xx(r.status), `walk-in joined a paused queue (${r.status})`);
      await patch(`/api/tenant/services/${svc.id}`, { queuePaused: false }, { token: Q.token });
      assert.equal((await walkIn(Q, svc.id, D0, 600)).status, 200, 'resumed');
    });
    it('archived location disappears from the public location list', async () => {
      const loc = Q.locations.find((l) => l.name === 'Q2');
      assert.equal((await patch(`/api/tenant/locations/${loc.id}`, { archived: true }, { token: Q.token })).status, 200);
      const names = (await get(`/api/public/tenant/${Q.id}/locations`)).json.locations.map((l) => l.name);
      assert.deepEqual(names, ['Q1']);
    });
    it('[D29] services of an archived location are hidden, closed and not joinable', async () => {
      const svc = Q.services[1];
      const listed = (await get(`/api/public/tenant/${Q.id}/services`)).json.services.some((s) => s.id === svc.id);
      const a = (await get(`/api/public/tenant/${Q.id}/services/${svc.id}/availability?date=${D0}&clockMinutes=600`)).json;
      const j = await walkIn(Q, svc.id, D0, 600);
      const msgs = [];
      if (listed) msgs.push('still listed publicly');
      if (a.open) msgs.push('availability open');
      if (!is4xx(j.status)) msgs.push(`join -> ${j.status}`);
      assert.deepEqual(msgs, []);
    });
    it('on-site-only: walk-ins need the location code; bookings do not', async () => {
      const O = await signup({ label: 'onsite' }); await goLive(O, O.services[0], { days: 2, hours: HOURS });
      const svc = O.services[0], code = O.locations[0].code;
      assert.equal((await patch('/api/tenant/me', { onsiteOnly: 'yes' }, { token: O.token })).status, 400);
      assert.equal((await patch('/api/tenant/me', { onsiteOnly: true }, { token: O.token })).status, 200);
      let r = await walkIn(O, svc.id, D0, 600); assert.equal(r.status, 403); assert.equal(r.json.reason, 'onsite_code_required');
      r = await walkIn(O, svc.id, D0, 600, { onsiteCode: 'QB-WRONG1' }); assert.equal(r.status, 403); assert.equal(r.json.reason, 'onsite_code_invalid');
      assert.equal((await walkIn(O, svc.id, D0, 600, { onsiteCode: ` ${code.toLowerCase()} ` })).status, 200);
      assert.equal((await booked(O, svc.id, D0, 600)).status, 200);
      const pub = (await get(`/api/public/tenant/${O.id}/locations`)).json.locations[0]; assert.equal(pub.onsite_only, true); assert.ok(!('code' in pub));
    });
    it('disabled business: every public tenant route 404s', async () => {
      const st = await systemToken(); const svc = Q.services[0];
      await patch(`/api/system/tenants/${Q.id}`, { status: 'disabled' }, { token: st });
      try {
        for (const [m, p, b] of [['GET', 'info'], ['GET', 'locations'], ['GET', 'services'], ['GET', `services/${svc.id}/availability?date=${D0}&clockMinutes=600`],
          ['POST', `services/${svc.id}/tickets`, { type: 'walk_in', date: D0, hourBlock: 600 }], ['GET', `tickets/${UUID0}/status`]]) {
          assert.equal((await api(m, `/api/public/tenant/${Q.id}/${p}`, { body: b })).status, 404, p);
        }
      } finally { await patch(`/api/system/tenants/${Q.id}`, { status: 'active' }, { token: st }); }
      assert.equal((await get(`/api/public/tenant/${Q.id}/info`)).status, 200);
    });
  });
});

// =====================================================================================
// 5. STAFF / QUEUE OPERATIONS
// =====================================================================================
describe('5. Staff & queue operations', () => {
  let S, D0, hy, ph, staff, sTok, aTok;
  const HOURS = [540, 570, 600, 630];
  const day = (i) => addDays(D0, i);
  const tix = async (date, tok = aTok) => (await get(`/api/tenant/tickets?date=${date}`, { token: tok })).json.tickets;
  const byId = async (id, date) => (await tix(date)).find((t) => t.id === id);
  const callNext = (svc, date, body = {}, tok = sTok) => atMinutes(body.clockMinutes ?? 620, () => post(`/api/tenant/services/${svc.id}/call-next`, { date, clockMinutes: 620, roomLabel: 'Room 1', ...body }, { token: tok }));
  const op = (id, ep, body = {}, tok = aTok) => atMinutes(body.clockMinutes ?? 620, () => post(`/api/tenant/tickets/${id}/${ep}`, { roomLabel: 'Room 2', clockMinutes: 620, ...body }, { token: tok }));
  const mkWalk = async (svc, date, n = 1) => { const out = []; for (let i = 0; i < n; i++) out.push((await walkIn(S, svc.id, date, 600)).json.ticket); return out; };
  const mkBook = async (svc, date, slot) => (await booked(S, svc.id, date, slot)).json.ticket;

  before(async () => {
    D0 = await today();
    S = await signup({ label: 'ops', locations: [{ name: 'Ops Main' }], services: [{ name: 'Dental Care', locationIndex: 0, mode: 'hybrid' }, { name: 'Pharmacy', locationIndex: 0, mode: 'queue' }] });
    [hy, ph] = S.services;
    await goLive(S, hy, { days: 12, hours: HOURS, staffCount: 20, bookingStaffCount: 10, walkInStaffCount: 10 });
    await goLive(S, ph, { days: 12, hours: HOURS, staffCount: 20, bookingStaffCount: 0, walkInStaffCount: 20 });
    staff = await addStaff(S, 'Stella', 'Staff'); sTok = await staffLogin(staff.email); aTok = S.token;
  });

  describe('call-next', () => {
    it('[D30] requires a room: blank / missing / whitespace / non-string -> 400 (non-string must not 500)', async () => {
      const d = day(1); await mkWalk(hy, d);
      await forAll([{ roomLabel: '' }, { roomLabel: '   ' }, { roomLabel: undefined }, { roomLabel: 5 }, { roomLabel: ['R'] }, { roomLabel: { a: 1 } }, { roomLabel: null }], async (b) => {
        const r = await post(`/api/tenant/services/${hy.id}/call-next`, { date: d, clockMinutes: 620, ...b }, { token: sTok });
        return r.status === 400 ? null : `${r.status}`;
      });
      assert.equal((await tix(d)).filter((t) => t.status === 'serving').length, 0, 'nobody was called');
    });
    it('orders due bookings by slot time first, then walk-ins FIFO; never calls a booking that is not yet due', async () => {
      const d = day(2);
      const [w1, w2, w3] = await mkWalk(hy, d, 3);
      const b630 = await mkBook(hy, d, 630); // slot 630: not due at clock 620
      const b600 = await mkBook(hy, d, 600), b540 = await mkBook(hy, d, 540);
      const order = [];
      for (let i = 0; i < 5; i++) { const r = await callNext(hy, d); assert.equal(r.status, 200, r.text); order.push(r.json.ticket.id); }
      assert.deepEqual(order, [b540.id, b600.id, w1.id, w2.id, w3.id]);
      assert.equal((await callNext(hy, d)).status, 404, 'only the not-yet-due booking is left');
      assert.equal((await callNext(hy, d, { clockMinutes: 630 })).json.ticket.id, b630.id, 'now due');
    });
    it('workType filters: "queue" = walk-ins only, "appointments" = bookings only', async () => {
      const d = day(3); const [w] = await mkWalk(hy, d); const b = await mkBook(hy, d, 540);
      assert.equal((await callNext(hy, d, { workType: 'appointments' })).json.ticket.id, b.id);
      assert.equal((await callNext(hy, d, { workType: 'appointments' })).status, 404);
      assert.equal((await callNext(hy, d, { workType: 'queue' })).json.ticket.id, w.id);
    });
    it('marks the ticket serving with room, caller and a patient message; patient link shows it', async () => {
      const d = day(4); const w = (await walkIn(S, hy.id, d, 600)).json;
      const r = await callNext(hy, d, { roomLabel: '  Room 12  ' });
      assert.equal(r.status, 200); const t = r.json.ticket;
      assert.equal(t.status, 'serving'); assert.equal(t.called_room, 'Room 12'); assert.equal(t.called_by_staff_id, staff.id); assert.equal(t.called_by_name, 'Stella Staff'); assert.ok(t.called_at);
      assert.match(r.json.message, /Room 12/);
      const pub = (await get(`/api/public/ticket/${w.publicToken}`)).json; assert.equal(pub.state, 'called'); assert.equal(pub.calledRoom, 'Room 12');
      const log = (await get('/api/tenant/audit-log', { token: aTok })).json.auditLog; assert.ok(log.some((l) => l.message.includes(t.ticket_number) && /called forward/.test(l.message)));
    });
    it('admin call-next has no staff attribution; empty queue / other date -> 404', async () => {
      const d = day(5); await mkWalk(hy, d);
      assert.equal((await callNext(hy, day(6), {}, aTok)).status, 404);
      const r = await callNext(hy, d, {}, aTok); assert.equal(r.json.ticket.called_by_staff_id, null);
    });
    it('simultaneous call-next never hands out the same ticket twice', async () => {
      const d = day(6); const [a, b] = await mkWalk(hy, d, 2);
      const rs = await Promise.all([callNext(hy, d), callNext(hy, d)]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200]);
      assert.deepEqual(new Set(rs.map((r) => r.json.ticket.id)), new Set([a.id, b.id]));
      const d2 = day(7); await mkWalk(hy, d2);
      const rs2 = await Promise.all([callNext(hy, d2), callNext(hy, d2), callNext(hy, d2)]);
      assert.deepEqual(rs2.map((r) => r.status).sort(), [200, 404, 404]);
    });
    it('cannot call another service\'s tickets via a different service id; unknown service -> nothing to call', async () => {
      const d = day(8); await mkWalk(ph, d);
      assert.equal((await callNext(hy, d)).status, 404);
      assert.equal((await callNext(ph, d)).status, 200);
      assert.ok(is4xx((await post(`/api/tenant/services/${UUID0}/call-next`, { date: d, clockMinutes: 1, roomLabel: 'R' }, { token: sTok })).status));
    });
    it('[D31] call-next with malformed date / clockMinutes is a 4xx (not 500)', async () => {
      await forAll([{ date: 'garbage' }, { date: '2026-13-40' }, { clockMinutes: 'abc' }, { clockMinutes: [1] }, { date: ['x'] }, { clockMinutes: 1e12 }], async (b) => {
        const r = await post(`/api/tenant/services/${hy.id}/call-next`, { date: day(1), clockMinutes: 620, roomLabel: 'R', ...b }, { token: sTok });
        return is4xx(r.status) ? null : `${r.status}`;
      });
    });
  });

  describe('single-ticket operations', () => {
    it('call: waiting or booked ticket (even out of turn / early); twice -> 409; needs a room', async () => {
      const d = day(1); const [w1, w2] = await mkWalk(hy, d, 2); const b = await mkBook(hy, d, 630);
      assert.equal((await op(w2.id, 'call', { roomLabel: '' })).status, 400);
      const r = await op(w2.id, 'call', { roomLabel: 'Room 3' }); assert.equal(r.status, 200); assert.equal(r.json.ticket.status, 'serving'); assert.equal(r.json.ticket.called_room, 'Room 3');
      assert.equal((await op(w2.id, 'call')).status, 409, 'cannot call twice');
      assert.equal((await op(b.id, 'call')).status, 200, 'booked patient called early');
      assert.equal((await byId(w1.id, d)).status, 'waiting');
    });
    it('call: closed tickets (completed / cancelled / no-show) cannot be called', async () => {
      const d = day(1); const [a, b, c] = await mkWalk(hy, d, 3);
      await op(a.id, 'call'); await op(a.id, 'close'); await op(b.id, 'cancel'); await op(c.id, 'call'); await op(c.id, 'no-show');
      for (const t of [a, b, c]) assert.equal((await op(t.id, 'call')).status, 409);
    });
    it('simultaneous call of one ticket: exactly one wins', async () => {
      const d = day(1); const [a] = await mkWalk(hy, d);
      const rs = await Promise.all([op(a.id, 'call', { roomLabel: 'A' }, sTok), op(a.id, 'call', { roomLabel: 'B' }, aTok)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    });
    it('call-again on a called ticket re-sends the message (and needs a room)', async () => {
      const d = day(1); const [a] = await mkWalk(hy, d); await op(a.id, 'call', { roomLabel: 'Room 1' });
      const r = await op(a.id, 'call-again', { roomLabel: 'Room 5' }); assert.equal(r.status, 200); assert.match(r.json.message, /Room 5/);
      assert.equal((await op(a.id, 'call-again', { roomLabel: ' ' })).status, 400);
      assert.equal((await op(UUID0, 'call-again')).status, 404);
    });
    it('return-to-queue: a called ticket becomes a waiting walk-in again; patient sees waiting', async () => {
      const d = day(10); const w = (await walkIn(S, hy.id, d, 600)).json; await op(w.ticket.id, 'call');
      const r = await op(w.ticket.id, 'return-to-queue', { clockMinutes: 575 });
      assert.equal(r.status, 200); const t = r.json.ticket;
      assert.equal(t.status, 'waiting'); assert.equal(t.type, 'walk_in'); assert.equal(t.called_at, null); assert.equal(t.slot_time, null); assert.equal(t.hour_block, 570);
      assert.equal((await get(`/api/public/ticket/${w.publicToken}`)).json.state, 'waiting');
      assert.equal((await callNext(hy, d)).json.ticket.id, w.ticket.id, 'it can be called again');
    });
    it('no-show: called ticket -> no_show; patient link shows closed; stats count it', async () => {
      const d = day(1); const w = (await walkIn(S, hy.id, d, 600)).json; await op(w.ticket.id, 'call');
      const before = (await get(`/api/tenant/dashboard/stats?date=${d}`, { token: aTok })).json.stats.no_show;
      const r = await op(w.ticket.id, 'no-show'); assert.equal(r.status, 200); assert.equal(r.json.ticket.status, 'no_show');
      assert.equal((await get(`/api/public/ticket/${w.publicToken}`)).json.state, 'closed');
      assert.equal((await get(`/api/tenant/dashboard/stats?date=${d}`, { token: aTok })).json.stats.no_show, before + 1);
    });
    it('cancel: waiting ticket -> cancelled (and frees capacity); unknown id -> 404', async () => {
      const d = day(9); const [a] = await mkWalk(hy, d); const b = await mkBook(hy, d, 540);
      assert.equal((await op(a.id, 'cancel')).json.ticket.status, 'cancelled'); assert.equal((await op(b.id, 'cancel')).json.ticket.status, 'cancelled');
      assert.equal((await op(UUID0, 'cancel')).status, 404);
      assert.equal((await callNext(hy, d)).status, 404, 'cancelled tickets are never called');
    });
    it('close: called ticket -> completed with finished_at; repeating is harmless', async () => {
      const d = day(1); const w = (await walkIn(S, hy.id, d, 600)).json; await op(w.ticket.id, 'call');
      assert.equal((await op(w.ticket.id, 'close')).status, 200);
      const t = await byId(w.ticket.id, d); assert.equal(t.status, 'completed'); assert.ok(t.finished_at); const f = t.finished_at;
      await op(w.ticket.id, 'close'); assert.equal((await byId(w.ticket.id, d)).finished_at, f);
      assert.equal((await op(UUID0, 'close')).status, 404);
    });
    it('route: moves a ticket to another service as a waiting walk-in and it is then callable there', async () => {
      const d = day(1); const w = (await walkIn(S, hy.id, d, 600)).json; await op(w.ticket.id, 'call');
      const r = await op(w.ticket.id, 'route', { newServiceId: ph.id, clockMinutes: 600 });
      assert.equal(r.status, 200); const t = r.json.ticket;
      assert.equal(t.service_id, ph.id); assert.equal(t.status, 'waiting'); assert.equal(t.type, 'walk_in'); assert.equal(t.slot_time, null); assert.equal(t.hour_block, 600); assert.equal(t.called_at, null);
      assert.equal((await get(`/api/public/ticket/${w.publicToken}`)).json.serviceName, 'Pharmacy');
      assert.equal((await callNext(ph, d)).json.ticket.id, w.ticket.id);
      assert.equal((await op(w.ticket.id, 'route', { newServiceId: UUID0 })).status, 404);
      assert.equal((await op(w.ticket.id, 'route', {})).status, 404);
    });
    it('[D32] a completed ticket cannot be re-opened by call-again / return-to-queue / no-show / cancel / route', async () => {
      const d = day(1); const mk = async () => { const [a] = await mkWalk(hy, d); await op(a.id, 'call'); await op(a.id, 'close'); return a; };
      await forAll([['call-again', {}], ['return-to-queue', {}], ['no-show', {}], ['cancel', {}], ['route', { newServiceId: ph.id }]], async ([ep, body]) => {
        const a = await mk(); const r = await op(a.id, ep, body); const now = await byId(a.id, d);
        return is4xx(r.status) && now.status === 'completed' ? null : `${r.status}, ticket is now '${now.status}'`;
      });
    });
    it('[D32b] a cancelled / no-show ticket cannot be returned to the queue, re-routed, closed or flipped to another end state', async () => {
      const d = day(1);
      await forAll([['cancelled', 'return-to-queue'], ['cancelled', 'close'], ['cancelled', 'no-show'], ['cancelled', 'route'], ['no_show', 'cancel'], ['no_show', 'close'], ['no_show', 'return-to-queue']], async ([end, ep]) => {
        const [a] = await mkWalk(hy, d); await op(a.id, 'call'); await op(a.id, end === 'cancelled' ? 'cancel' : 'no-show');
        const r = await op(a.id, ep, { newServiceId: ph.id }); const now = await byId(a.id, d);
        return is4xx(r.status) && now.status === end ? null : `${end} + ${ep}: ${r.status}, ticket is now '${now.status}'`;
      });
    });
    it('[D33] close / call-again on a ticket that was never called is refused', async () => {
      const d = day(1);
      await forAll(['close', 'call-again'], async (ep) => {
        const [a] = await mkWalk(hy, d); const r = await op(a.id, ep); const now = await byId(a.id, d);
        return is4xx(r.status) && now.status === 'waiting' ? null : `${ep}: ${r.status}, ticket is now '${now.status}'`;
      });
    });
    it('[D34] PATCH /tickets/:id changing only the status keeps slot_time; invalid status is a 4xx', async () => {
      const d = day(1); const b = await mkBook(hy, d, 570);
      const r = await patch(`/api/tenant/tickets/${b.id}`, { status: 'cancelled' }, { token: aTok });
      assert.equal(r.status, 200);
      assert.equal((await byId(b.id, d)).slot_time, 570, 'slot_time was wiped by an unrelated status change');
      const bad = await patch(`/api/tenant/tickets/${b.id}`, { status: 'exploded' }, { token: aTok });
      assert.ok(is4xx(bad.status), `invalid status -> ${bad.status}`);
    });
    it('stale in-progress tickets from a past day are system-closed when tickets are listed', needsDb, async () => {
      const d = day(1); const [a] = await mkWalk(hy, d); await op(a.id, 'call');
      sql(`update tickets set visit_date='${addDays(D0, -3)}' where id='${a.id}'`);
      const list = await tix(addDays(D0, -3)); const t = list.find((x) => x.id === a.id);
      assert.equal(t.status, 'completed'); assert.equal(t.closed_by_system, true); assert.ok(t.finished_at);
    });
  });

  describe('stats and today consistent with ticket states', () => {
    let svc;
    before(async () => {
      svc = (await post('/api/tenant/services', { name: 'Stats Clinic', locationId: S.locations[0].id }, { token: aTok })).json.service;
      await goLive(S, svc, { days: 1, hours: HOURS, staffCount: 20, bookingStaffCount: 10, walkInStaffCount: 10 });
    });
    const stats = async () => (await get(`/api/tenant/dashboard/stats?date=${D0}`, { token: aTok })).json.stats;
    const today_ = async (clock = 560) => atMinutes(clock, async () => (await get(`/api/tenant/today?serviceId=${svc.id}&clockMinutes=${clock}`, { token: sTok })).json);
    it('counts follow every state change', async () => {
      const s0 = await stats();
      const w = []; for (let i = 0; i < 3; i++) w.push((await walkIn(S, svc.id, D0, 540)).json.ticket);
      const b1 = (await booked(S, svc.id, D0, 540)).json.ticket, b2 = (await booked(S, svc.id, D0, 555)).json.ticket;
      let s = await stats(); assert.equal(s.waiting - s0.waiting, 3); assert.equal(s.booked - s0.booked, 2);
      let t = await today_(); assert.equal(t.open, true); assert.equal(t.queueCount, 3); assert.equal(t.totals.bookedTotal, 2);
      const blk = t.blocks.find((b) => b.start === 540); assert.equal(blk.booked, 2); assert.equal(blk.walkIn, 3);
      assert.equal(t.blocks.length, HOURS.length);

      await op(w[0].id, 'call');                                  // serving
      s = await stats(); assert.equal(s.serving - s0.serving, 1); assert.equal(s.waiting - s0.waiting, 2);
      assert.equal((await today_()).queueCount, 2);
      await op(w[0].id, 'no-show');                               // no_show
      await op(w[1].id, 'call'); await op(w[1].id, 'close');      // completed
      await op(b1.id, 'cancel');                                  // cancelled booking
      s = await stats();
      assert.deepEqual([s.no_show - s0.no_show, s.completed - s0.completed, s.cancelled - s0.cancelled, s.waiting - s0.waiting, s.booked - s0.booked], [1, 1, 1, 1, 1]);
      t = await today_(); assert.equal(t.queueCount, 1); assert.equal(t.totals.bookedTotal, 1, 'cancelled booking no longer counted');
      assert.equal(t.blocks.find((b) => b.start === 540).booked, 1);

      // every ticket of the day is counted exactly once
      const list = (await tix(D0)); const sum = Object.values(await stats()).reduce((a, b) => a + b, 0);
      assert.equal(sum, list.length);
      for (const [k, v] of Object.entries(await stats())) assert.equal(list.filter((x) => x.status === k).length, v, k);
      assert.equal(list.filter((x) => x.service_id === svc.id && x.status === 'waiting' && x.type === 'walk_in').length, t.queueCount);
      void b2;
    });
    it('today: capacity figures, closed service, bad input', async () => {
      const t = await today_(560);
      const blk = t.blocks[0]; assert.equal(blk.staff, 20); assert.equal(blk.bookingCapacity, 20); assert.equal(blk.walkinCapacity, 20); assert.equal(t.staffNow, 20);
      assert.equal((await get(`/api/tenant/today`, { token: sTok })).status, 400);
      assert.equal((await get(`/api/tenant/today?serviceId=${UUID0}`, { token: sTok })).status, 404);
      const closed = (await post('/api/tenant/services', { name: 'Closed Svc', locationId: S.locations[0].id }, { token: aTok })).json.service;
      const c = (await get(`/api/tenant/today?serviceId=${closed.id}`, { token: sTok })).json; assert.equal(c.open, false); assert.equal(c.reason, 'outside_license_window');
    });
    it('ticket list is per-date and newest first; staff list agrees with admin list', async () => {
      const a = await tix(D0, aTok), b = await tix(D0, sTok);
      assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
      for (let i = 1; i < a.length; i++) assert.ok(new Date(a[i - 1].created_at) >= new Date(a[i].created_at));
      assert.ok(a.every((x) => x.visit_date === D0));
    });
    it('staff-created tickets (kiosk) follow the same licence rules', async () => {
      const r = await post(`/api/tenant/services/${svc.id}/tickets`, { type: 'walk_in', date: D0, hourBlock: 540 }, { token: sTok });
      assert.equal(r.status, 200); assert.equal(r.json.ticket.status, 'waiting');
      assert.equal((await post(`/api/tenant/services/${svc.id}/tickets`, { type: 'walk_in', date: addDays(D0, 90), hourBlock: 540 }, { token: sTok })).status, 409);
      assert.equal((await post(`/api/tenant/services/${UUID0}/tickets`, { type: 'walk_in', date: D0 }, { token: sTok })).status, 404);
    });
  });
});

// =====================================================================================
// 6. SECURITY & ROBUSTNESS
// =====================================================================================
describe('6. Security & robustness', () => {
  let R, D0, svc, svc2, loc, tk, lic, stf, st;
  const LEAK = /(\n\s+at\s+\S+.*\(|node_modules|\/home\/|invalid input syntax|\$2[aby]\$|testsecret|DATABASE_URL|JWT_SECRET)/i;
  before(async () => {
    D0 = await today(); st = await systemToken();
    R = await signup({ label: 'robust', locations: [{ name: 'R1' }], services: [{ name: 'Robust Svc', locationIndex: 0 }, { name: 'Second Svc', locationIndex: 0 }] });
    [svc, svc2] = R.services; loc = R.locations[0];
    await goLive(R, svc, { days: 3, hours: [540, 570, 600], staffCount: 30, bookingStaffCount: 5, walkInStaffCount: 25 });
    const stf_ = await addStaff(R); stf = stf_;
    tk = (await walkIn(R, svc.id, D0, 540)).json.ticket;
    lic = (await get(`/api/tenant/services/${svc.id}/licenses`, { token: R.token })).json.licenses.find((l) => l.status === 'available');
  });

  describe('identifier handling', () => {
    // [method, path(id), body, auth]  ; {id} is replaced; auth: 'admin' | 'sys' | none
    const T_ = () => `/api/public/tenant`;
    const endpoints = (id) => [
      ['GET', `/api/public/tenant/${id}/info`], ['GET', `/api/public/tenant/${id}/locations`], ['GET', `/api/public/tenant/${id}/services`],
      ['GET', `/api/public/tenant/${R.id}/services/${id}/availability?date=${D0}&clockMinutes=1`], ['POST', `/api/public/tenant/${R.id}/services/${id}/tickets`, { type: 'walk_in', date: D0, hourBlock: 540 }],
      ['GET', `/api/public/tenant/${R.id}/tickets/${id}/status`], ['POST', `/api/public/tenant/${R.id}/tickets/${id}/cancel`, {}], ['POST', `/api/public/tenant/${R.id}/tickets/${id}/check-in`, {}],
      ['GET', `/api/public/tenant/${id}/services/${svc.id}/availability?date=${D0}&clockMinutes=1`],
      ['PATCH', `/api/tenant/locations/${id}`, { name: 'x' }], ['PATCH', `/api/tenant/services/${id}`, { name: 'x' }],
      ['GET', `/api/tenant/services/${id}/licenses`], ['POST', `/api/tenant/services/${id}/licenses`, { planId: 'day', paymentMethod: 'card' }],
      ['PATCH', `/api/tenant/services/${svc.id}/licenses/${id}`, { startDate: D0 }], ['POST', `/api/tenant/services/${svc.id}/licenses/${id}/move`, { targetServiceId: svc2.id }],
      ['POST', `/api/tenant/services/${svc.id}/licenses/${id}/pay`, { paymentMethod: 'card' }], ['POST', `/api/tenant/services/${svc.id}/licenses/${id}/refund`, {}],
      ['GET', `/api/tenant/services/${id}/daily-config?from=${D0}&to=${D0}`], ['PUT', `/api/tenant/services/${id}/daily-config`, { date: D0, hours: [] }],
      ['POST', `/api/tenant/services/${id}/daily-config/copy`, { fromDate: D0, toDates: [] }], ['POST', `/api/tenant/services/${id}/daily-config/clear-all`, {}],
      ['GET', `/api/tenant/today?serviceId=${id}`], ['GET', `/api/tenant/services/${id}/availability?date=${D0}&clockMinutes=1`], ['POST', `/api/tenant/services/${id}/tickets`, { type: 'walk_in', date: D0 }],
      ['POST', `/api/tenant/services/${id}/call-next`, { date: D0, clockMinutes: 1, roomLabel: 'R' }],
      ['PATCH', `/api/tenant/tickets/${id}`, { status: 'cancelled' }], ['DELETE', `/api/tenant/tickets/${id}`],
      ...['call', 'call-again', 'return-to-queue', 'cancel', 'no-show', 'route', 'close'].map((ep) => ['POST', `/api/tenant/tickets/${id}/${ep}`, { roomLabel: 'R', clockMinutes: 1, newServiceId: svc2.id }]),
      ['PATCH', `/api/tenant/staff/${id}`, { firstName: 'x' }], ['DELETE', `/api/tenant/staff/${id}`],
      ['GET', `/api/system/tenants/${id}/detail`, undefined, 'sys'], ['PATCH', `/api/system/tenants/${id}/staff/${id}`, { firstName: 'x' }, 'sys'],
      ['POST', `/api/system/tenants/${id}/licenses/${id}/mark-paid`, {}, 'sys'], ['POST', `/api/system/tenants/${id}/services/${id}/licenses/free`, { planId: 'day' }, 'sys'],
      ['PATCH', `/api/system/tenants/${id}/locations/${id}`, { name: 'x' }, 'sys'], ['PATCH', `/api/system/tenants/${id}/services/${id}`, { name: 'x' }, 'sys'],
      ['DELETE', `/api/system/tenants/${id}/services/${id}`, undefined, 'sys'], ['DELETE', `/api/system/tenants/${id}/locations/${id}`, undefined, 'sys'], ['DELETE', `/api/system/tenants/${id}`, undefined, 'sys'],
    ];
    const run = async (id) => {
      const bad = [];
      for (const [m, p, body, who] of endpoints(id)) {
        const token = who === 'sys' ? st : (p.startsWith('/api/tenant') ? R.token : undefined);
        const r = await api(m, p, { token, body });
        if (r.status >= 500 || r.status === 200 || r.status === 201) bad.push(`${m} ${p.replace(String(id), '<id>').replace(String(encodeURIComponent(id)), '<id>').slice(0, 90)} -> ${r.status}`);
      }
      return bad;
    };
    it('[D35] a syntactically invalid UUID in a path/query id is answered 4xx (404/400), never 500', async () => {
      const bad = await run('not-a-uuid');
      assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
    });
    it('SQL-injection strings in ids behave exactly like any other bad id: fast, no DB error text, data intact', async () => {
      const c0 = PSQL_OK ? sql('select count(*) from tickets') : null;
      for (const inj of ["' OR '1'='1", "1; select pg_sleep(4)--", "' UNION SELECT null,null--", "%27%3B%20DROP%20TABLE%20tickets%3B--"]) {
        const t0 = Date.now(); const base = await run(encodeURIComponent(inj));
        assert.ok(Date.now() - t0 < 4000 + base.length * 50 + 3000, `slow response for ${inj} - possible injection`);
        assert.ok(!base.some((x) => / 200$/.test(x)), `a request with an injection id succeeded: ${base.filter((x) => / 200$/.test(x))}`);
      }
      if (PSQL_OK) { assert.ok(Number(sql('select count(*) from tickets')) >= Number(c0)); assert.ok(Number(sql('select count(*) from tenants')) > 0); }
      const r = await get(`/api/public/code/${encodeURIComponent("QB-AAAAAA' or '1'='1")}`); assert.equal(r.status, 404);
    });
    it('unknown (valid) UUIDs are 404, not 500, on every route', async () => {
      const bad = [];
      for (const [m, p, body, who] of endpoints(UUID0)) {
        if (/\/api\/tenant\/(tickets|services)\/[^/]*\/(daily-config\/clear-all)/.test(p)) continue;
        const r = await api(m, p, { token: who === 'sys' ? st : (p.startsWith('/api/tenant') ? R.token : undefined), body });
        if (r.status >= 500) bad.push(`${m} ${p.slice(0, 80)} -> ${r.status}`);
      }
      assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
    });
    it('injection strings in text fields are stored verbatim (parameterised) and tables survive', async () => {
      const inj = "Robert'); DROP TABLE tickets;-- \"quoted\" \\ <script>alert(1)</script> 💥";
      const l = await post('/api/tenant/locations', { name: inj, address: inj }, { token: R.token });
      assert.equal(l.status, 200); assert.equal(l.json.location.name, inj);
      const sv = await post('/api/tenant/services', { name: inj, locationId: l.json.location.id }, { token: R.token });
      assert.equal(sv.json.service.name, inj);
      assert.equal((await patch('/api/tenant/me', { companyAddress: inj }, { token: R.token })).json.tenant.company_address, inj);
      const s2 = await addStaff(R, inj, inj); assert.ok(s2.id);
      assert.ok((await get(`/api/tenant/tickets?date=${D0}`, { token: R.token })).json.tickets.length >= 1);
      if (PSQL_OK) assert.equal(Number(sql(`select count(*) from information_schema.tables where table_name='tickets'`)), 1);
    });
    it('[D36] a malformed date in a query/body is a 4xx (not 500), including a valid-looking prefix', async () => {
      const dates = ['garbage', '2026-13-45', `${D0}x`, `${D0}' or '1'='1`, `${D0}T00:00:00Z junk`, '', '0'];
      const bad = [];
      for (const d of dates) {
        const q = encodeURIComponent(d);
        for (const [m, p, tok, body] of [
          ['GET', `/api/tenant/tickets?date=${q}`, R.token], ['GET', `/api/tenant/dashboard/stats?date=${q}`, R.token],
          ['GET', `/api/tenant/services/${svc.id}/daily-config?from=${q}&to=${q}`, R.token], ['GET', `/api/tenant/services/${svc.id}/availability?date=${q}&clockMinutes=1`, R.token],
          ['GET', `/api/public/tenant/${R.id}/services/${svc.id}/availability?date=${q}&clockMinutes=1`], ['POST', `/api/public/tenant/${R.id}/services/${svc.id}/tickets`, undefined, { type: 'walk_in', date: d, hourBlock: 540 }],
          ['PUT', `/api/tenant/services/${svc.id}/daily-config`, R.token, { date: d, hours: [] }],
        ]) { const r = await api(m, p, { token: tok, body }); if (r.status >= 500) bad.push(`${m} ${p.replace(q, '<d>').slice(0, 70)} date=${JSON.stringify(d)} -> ${r.status}`); }
      }
      assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
    });
  });

  describe('malformed requests', () => {
    it('[D37] oversized JSON body -> 413 (not 500)', async () => {
      const r = await api('POST', '/api/tenant/locations', { token: R.token, body: { name: 'x', address: 'y'.repeat(300 * 1024) } });
      assert.equal(r.status, 413, `${r.status} ${r.text.slice(0, 80)}`);
      const r2 = await api('POST', '/api/auth/admin/request-otp', { rawBody: JSON.stringify({ email: 'a'.repeat(5 * 1024 * 1024) }) });
      assert.equal(r2.status, 413, `${r2.status}`);
    });
    it('a large-but-legal body (about 80 KB) does not crash the server', async () => {
      const r = await post('/api/auth/admin/request-otp', { email: 'a'.repeat(80 * 1024) });
      assert.ok(r.status < 500, `${r.status}`); assert.equal((await get('/health')).status, 200);
    });
    it('[D38] invalid JSON -> 400 (not 500)', async () => {
      await forAll(['{"a":', '{', 'not json', '{"a":1}}', "{'a':1}", '[1,2', '\u0000'], async (rawBody) => {
        const r = await api('POST', '/api/auth/admin/request-otp', { rawBody }); return r.status === 400 ? null : `${r.status}`;
      });
    });
    it('[D38b] JSON scalars / null as the body -> 400 (not 500)', async () => {
      await forAll(['null', '123', '"str"', 'true'], async (rawBody) => {
        const r = await api('POST', '/api/auth/admin/request-otp', { rawBody }); return r.status === 400 ? null : `${r.status}`;
      });
    });
    it('array / empty / non-JSON content types never 500', async () => {
      await forAll([['[]', 'application/json'], ['{}', 'application/json'], ['', 'application/json'], ['email=a', 'application/x-www-form-urlencoded'], ['hello', 'text/plain']], async ([rawBody, ct]) => {
        for (const p of ['/api/auth/admin/request-otp', '/api/auth/admin/verify-otp', '/api/auth/staff/request-otp', '/api/auth/staff/verify-otp', '/api/auth/system/login', '/api/auth/signup']) {
          const r = await api('POST', p, { rawBody, headers: { 'content-type': ct } }); if (r.status >= 500) return `${p} -> ${r.status}`;
        }
        return null;
      });
    });
    it('prototype-pollution style bodies do not break anything', async () => {
      const r = await api('POST', '/api/auth/admin/request-otp', { rawBody: '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"email":"nobody@example.com"}' });
      assert.equal(r.status, 200); // CHANGED: unknown address is now the uniform 200 (was 404)
      assert.equal(({}).admin, undefined);
      assert.equal((await get('/api/tenant/me', { token: R.token })).status, 200);
    });
    it('unknown routes and wrong methods answer 404 without leaking internals', async () => {
      for (const [m, p] of [['GET', '/nope'], ['POST', '/api/tenant/nope'], ['DELETE', '/api/public/tenant'], ['PUT', '/health'], ['GET', '/api/../../etc/passwd'], ['GET', '/%2e%2e/%2e%2e/etc/passwd'], ['GET', '/api/tenant/%']]) {
        const r = await api(m, p, { token: R.token }); assert.ok(r.status === 404 || r.status === 401 || r.status === 400, `${m} ${p} -> ${r.status}`); assert.ok(!LEAK.test(r.text), `${m} ${p}: ${r.text.slice(0, 120)}`);
      }
    });
  });

  describe('typed-value sweep (every mutating endpoint x every field x hostile values)', () => {
    const MUT = [null, 123, -1, 1e21, true, [], ['x'], {}, { $ne: 1 }, '', '   ', 'x'.repeat(400), "'; select 1;--", '\u0000', '2026-99-99', '0'];
    const specs = () => [
      ['PATCH', '/api/tenant/me', { businessName: 'api-test-sweep', firstName: 'a', lastName: 'b', companyAddress: 'c', websiteUrl: 'http://x.example', channelMode: 'both', whatsappUpdatesOffer: true, onsiteOnly: false }],
      ['POST', '/api/tenant/setup/dismiss', { task: 'website' }], ['POST', '/api/tenant/pay-now', { paymentMethod: 'card', invoiceEmail: 'a@b.com', invoicePO: 'PO' }],
      ['POST', '/api/tenant/locations', { name: 'Sweep Loc', address: 'a' }], ['PATCH', `/api/tenant/locations/${loc.id}`, { name: 'R1', address: 'a', archived: false }],
      ['POST', '/api/tenant/services', { name: 'Sweep Svc', locationId: loc.id }],
      ['PATCH', `/api/tenant/services/${svc2.id}`, { name: 'Second Svc', slotMinutes: 15, mode: 'hybrid', queuePaused: false, queueStaffCount: 2, archived: false }],
      ['POST', `/api/tenant/services/${svc2.id}/licenses`, { planId: 'day', customDays: 2, paymentMethod: 'card', invoiceEmail: 'a@b.com', invoicePO: 'PO' }],
      ['PATCH', `/api/tenant/services/${svc.id}/licenses/${lic.id}`, { startDate: addDays(D0, 60), unschedule: false }],
      ['POST', `/api/tenant/services/${svc.id}/licenses/${lic.id}/move`, { targetServiceId: svc2.id }], ['POST', `/api/tenant/services/${svc.id}/licenses/${lic.id}/pay`, { paymentMethod: 'card', invoicePO: 'x' }],
      ['PUT', `/api/tenant/services/${svc.id}/daily-config`, { date: addDays(D0, 2), hours: [540], staffCount: 2, bookingStaffCount: 1, walkInStaffCount: 1, nowMinutes: 0 }],
      ['POST', `/api/tenant/services/${svc.id}/daily-config/copy`, { fromDate: addDays(D0, 1), toDates: [addDays(D0, 2)] }],
      ['POST', '/api/tenant/staff', { firstName: 'a', lastName: 'b', email: `api-test-sweep-${rnd()}@example.com` }], ['PATCH', `/api/tenant/staff/${stf.id}`, { firstName: 'a', lastName: 'b', email: `api-test-sweep-${rnd()}@example.com`, active: true }],
      ['PATCH', `/api/tenant/tickets/${tk.id}`, { status: 'waiting', serviceId: svc.id, locationId: loc.id, slotTime: null, type: 'walk_in', hourBlock: 540 }],
      ['POST', `/api/tenant/services/${svc.id}/call-next`, { date: addDays(D0, 1), clockMinutes: 600, roomLabel: 'R', workType: 'queue' }],
      ['POST', `/api/tenant/tickets/${tk.id}/call`, { roomLabel: 'R' }], ['POST', `/api/tenant/tickets/${tk.id}/call-again`, { roomLabel: 'R' }],
      ['POST', `/api/tenant/tickets/${tk.id}/return-to-queue`, { clockMinutes: 600 }], ['POST', `/api/tenant/tickets/${tk.id}/route`, { newServiceId: svc.id, clockMinutes: 600 }],
      ['POST', `/api/tenant/services/${svc.id}/tickets`, { type: 'walk_in', slotTime: null, hourBlock: 540, date: addDays(D0, 1) }],
      ['POST', `/api/public/tenant/${R.id}/services/${svc.id}/tickets`, { type: 'walk_in', slotTime: null, hourBlock: 540, date: addDays(D0, 1), onsiteCode: 'QB-AAAAAA', deviceId: 'abcdefghijklmnop1234' }],
      ['POST', '/api/auth/admin/request-otp', { email: R.email }], ['POST', '/api/auth/admin/verify-otp', { email: R.email, code: '000000' }],
      ['POST', '/api/auth/staff/request-otp', { email: 'x@example.com' }], ['POST', '/api/auth/staff/verify-otp', { email: 'x@example.com', code: '000000' }],
      ['POST', '/api/auth/system/login', { password: 'nope' }], ['POST', '/api/whatsapp/webhook', { from: '+447000000000', text: 'hello' }],
      ['PATCH', `/api/system/tenants/${R.id}`, { businessName: R.businessName, firstName: 'a', lastName: 'b', email: R.email, companyAddress: 'x', locationCount: 1, status: 'active' }, 'sys'],
      ['POST', `/api/system/tenants/${R.id}/services/${svc2.id}/licenses/free`, { planId: 'day', customDays: 1 }, 'sys'],
      ['POST', `/api/system/tenants/${R.id}/services/${svc2.id}/licenses/annual`, { price: 100 }, 'sys'],
    ];
    it('[D39] no field of any endpoint turns a hostile value into a 500 (report lists endpoint -> field = value)', async () => {
      const failures = new Map(); let sent = 0;
      for (const [m, p, base, who] of specs()) {
        const token = who === 'sys' ? st : (p.startsWith('/api/tenant') ? R.token : undefined);
        for (const key of Object.keys(base)) {
          for (const v of MUT) {
            if (v === base[key] ) continue;
            sent++;
            const r = await api(m, p, { token, body: { ...base, [key]: v } });
            if (r.status >= 500) { const k = `${m} ${p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')} .${key}`; (failures.get(k) || failures.set(k, []).get(k)).push(JSON.stringify(v)?.slice(0, 18)); }
            else assert.ok(!LEAK.test(r.text), `${m} ${p} ${key}=${JSON.stringify(v)?.slice(0, 20)} leaked: ${r.text.slice(0, 120)}`);
          }
        }
      }
      // Some hostile-looking values are valid ones (archived: true, onsiteOnly: true) and really apply: put the fixture back for later tests.
      await patch(`/api/tenant/locations/${loc.id}`, { archived: false }, { token: R.token });
      await patch('/api/tenant/me', { onsiteOnly: false }, { token: R.token });
      await putDay(R, svc.id, addDays(D0, 2), { hours: [540, 570, 600], staffCount: 30, bookingStaffCount: 5, walkInStaffCount: 25 }); // the sweep rewrites this day's staffing
      const lines = [...failures].map(([k, v]) => `${k}  <- ${[...new Set(v)].slice(0, 5).join(' ')}${v.length > 5 ? ` (+${v.length - 5})` : ''}`);
      assert.equal(lines.length, 0, `${sent} requests, ${lines.length} endpoint fields give 500:\n  ${lines.join('\n  ')}`);
    });
  });

  describe('rate limiting & client IP trust', () => {
    it('public ticket creation: 20 per 10 minutes per IP, then 429 + Retry-After + JSON error', async () => {
      const ip = randIp(); const codes = [];
      let last;
      for (let i = 0; i < 22; i++) { last = await post(`/api/public/tenant/${R.id}/services/${UUID0}/tickets`, { type: 'walk_in', date: D0 }, { ip }); codes.push(last.status); }
      assert.deepEqual(codes.slice(0, 20).filter((c) => c === 429), [], `limited too early: ${codes}`);
      assert.equal(codes[20], 429); assert.equal(codes[21], 429);
      assert.ok(Number(last.headers.get('retry-after')) > 0); assert.ok(typeof last.json.error === 'string'); assert.ok(!LEAK.test(last.text));
      assert.notEqual((await post(`/api/public/tenant/${R.id}/services/${UUID0}/tickets`, { type: 'walk_in', date: D0 }, { ip: randIp() })).status, 429, 'other IP is not limited');
    });
    it('the limiter counts real joins too (a 429 never creates a ticket)', async () => {
      const ip = randIp(); const before = PSQL_OK ? Number(sql(`select count(*) from tickets where tenant_id='${R.id}'`)) : 0; let made = 0;
      for (let i = 0; i < 25; i++) { const r = await walkIn(R, svc.id, addDays(D0, 1 + (i % 2)), 540, { deviceId: `dev${rnd()}${rnd()}${rnd()}` }, ip); if (r.status === 200) made++; else assert.equal(r.status, 429, r.text); }
      assert.ok(made <= 20 && made > 0, `made ${made}`);
      if (PSQL_OK) assert.equal(Number(sql(`select count(*) from tickets where tenant_id='${R.id}'`)), before + made);
    });
    it('[D40] the limiter cannot be evaded by sending a different X-Forwarded-For on each request', async () => {
      // The proxy (Railway) appends the address it really saw as the LAST entry; anything the client put in front is spoofed.
      const realClient = randIp(); const codes = [];
      for (let i = 0; i < 30; i++) codes.push((await post(`/api/public/tenant/${R.id}/services/${UUID0}/tickets`, { type: 'walk_in', date: D0 }, { ip: `${randIp()}, ${realClient}` })).status);
      assert.ok(codes.includes(429), 'no request was limited: client-supplied X-Forwarded-For entries are trusted as the client IP (trust proxy must be a hop count, not true); the per-IP and per-device caps are bypassable');
    });
  });

  describe('information disclosure & CORS', () => {
    it('[D41] responses do not advertise the framework (X-Powered-By)', async () => {
      const r = await get('/health'); assert.equal(r.headers.get('x-powered-by'), null, `X-Powered-By: ${r.headers.get('x-powered-by')}`);
    });
    it('error bodies (4xx and 5xx) are short JSON without stack traces, SQL, paths or secrets', async () => {
      const bad = [];
      for (const [m, p, body, tok] of [['GET', '/api/tenant/me', undefined, 'garbage'], ['GET', `/api/public/tenant/not-a-uuid/info`], ['POST', '/api/auth/admin/verify-otp', { email: ['x'] }],
        ['PATCH', `/api/tenant/tickets/${tk.id}`, { status: 'exploded' }, R.token], ['PUT', `/api/tenant/services/${svc.id}/daily-config`, { date: D0, staffCount: 'abc' }, R.token], ['GET', '/api/public/ticket/x'], ['POST', '/api/auth/system/login', { password: 5 }]]) {
        const r = await api(m, p, { token: tok, body });
        if (LEAK.test(r.text) || r.text.length > 400) bad.push(`${m} ${p}: ${r.text.slice(0, 160)}`);
        if (r.status >= 400 && !r.json) bad.push(`${m} ${p}: not JSON`);
      }
      assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
    });
    it('system login and tenant payloads never contain password hashes or JWT secrets', async () => {
      const blob = JSON.stringify([(await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json, (await get('/api/tenant/me', { token: R.token })).json, (await get('/api/system/tenants', { token: st })).json]);
      assert.ok(!/\$2[aby]\$/.test(blob)); assert.ok(!blob.includes(JWT_SECRET));
    });
    it('CORS: authenticated APIs only allow the configured origin; public APIs are open', async () => {
      const evil = { origin: 'https://evil.example' };
      for (const p of ['/api/tenant/me', '/api/auth/admin/request-otp', '/api/system/tenants']) {
        const r = await api('GET', p, { token: R.token, headers: evil }); assert.equal(r.headers.get('access-control-allow-origin'), null, `${p} reflects a foreign origin`);
        const o = await api('OPTIONS', p, { headers: { ...evil, 'access-control-request-method': 'POST' } }); assert.equal(o.headers.get('access-control-allow-origin'), null, `${p} preflight`);
      }
      const ok = await api('GET', '/api/tenant/me', { token: R.token, headers: { origin: 'http://localhost:5173' } });
      assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal((await api('GET', `/api/public/tenant/${R.id}/info`, { headers: evil })).headers.get('access-control-allow-origin'), '*');
    });
    it('WhatsApp webhook: validates input and only maps real location codes', async () => {
      assert.equal((await post('/api/whatsapp/webhook', {})).status, 400);
      assert.equal((await post('/api/whatsapp/webhook', { from: '+447000000001', text: 'hi' })).json.noSession, true);
      const code = loc.code; const phone = `+4470${ri(99999999)}`;
      const r = await post('/api/whatsapp/webhook', { from: phone, text: `hello ${code.toLowerCase()} please` });
      assert.equal(r.json.matchedCode, code);
      assert.equal((await post('/api/whatsapp/webhook', { from: phone, text: 'next' })).json.session.tenant_id, R.id);
      assert.equal((await post('/api/whatsapp/webhook', { from: phone, text: 'QB-ZZZZZZ' })).json.session.tenant_id, R.id, 'unknown code keeps the previous session');
    });
  });
});

// =====================================================================================
// 7. SERVER LOG
// =====================================================================================
describe('7. Server log', () => {
  it('[D42] no unexpected "Error" entries were logged while the suite ran (every one is a 500 caused by client input)', (t) => {
    if (logStart === null) return t.skip('server log not readable');
    const fd = fs.openSync(SERVER_LOG, 'r'); const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(size - logStart);
    fs.readSync(fd, buf, 0, buf.length, logStart); fs.closeSync(fd);
    const errs = buf.toString().split('\n').filter((l) => /^\s*(\w*Error|error:|Unhandled)/.test(l));
    const counts = {}; for (const e of errs) counts[e.slice(0, 110)] = (counts[e.slice(0, 110)] || 0) + 1;
    const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v} x ${k}`);
    assert.equal(errs.length, 0, `${errs.length} error lines (note: log is shared with concurrent clients):\n  ${summary.join('\n  ')}`);
  });
});
