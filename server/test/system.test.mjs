// QBooker System Admin API test suite.  Run:  node --test server/test/system.test.mjs
//
// Covers the platform-team console: POST /api/auth/system/login, everything under /api/system/*, and the public
// /api/public/pricing + /api/public/clock that the console feeds.
//
// Env:  BASE_URL        (default http://localhost:4100)
//       JWT_SECRET      (default "testsecret"; only used to forge tokens for negative tests)
//       SYSTEM_PASSWORD (default "adminpass")
//       PGHOST/PGPORT/PGDATABASE/PGUSER  (default /tmp/pgtest, 5433, qb_test, postgres) - psql is used to build
//                       fixtures (tenants, licences in every state, revenue figures) and to verify side effects.
//
// Conventions: everything created is prefixed `sys-test-`. Every request carries a random X-Forwarded-For so the
// in-memory per-IP rate limiters are never shared with other clients (the server trusts one proxy hop).
// The platform pricing row and the simulated clock are global state: both are saved up front and restored at the end.
//
// Tests whose title carries [S##] assert intended behaviour that the app violated when the suite was written
// (genuine defects, fixed in the same change). Everything else is expected to pass.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signupV, verifyEmail } from './signup-helper.mjs';

const BASE = (process.env.BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
const SYSTEM_PASSWORD = process.env.SYSTEM_PASSWORD || 'adminpass';
const PG = {
  host: process.env.PGHOST || '/tmp/pgtest', port: process.env.PGPORT || '5433',
  db: process.env.PGDATABASE || 'qb_test', user: process.env.PGUSER || 'postgres',
};

const RUN = crypto.randomBytes(3).toString('hex');
const rnd = () => crypto.randomBytes(4).toString('hex');
const ri = (n) => crypto.randomInt(n);
const randIp = () => `10.${ri(250) + 1}.${ri(250) + 1}.${ri(250) + 1}`;
const UUID0 = '00000000-0000-4000-8000-000000000000';

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
function sql(q) {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlJson(q) { return JSON.parse(sql(`select coalesce(json_agg(t),'[]'::json) from (${q}) t`)); }
let PSQL_OK = false;
try { PSQL_OK = sql('select 1') === '1'; } catch { PSQL_OK = false; }
if (!PSQL_OK) throw new Error('psql access to the test database is required for system.test.mjs');
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const code6 = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[ri(32)]).join('');

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
const is4xx = (s) => s >= 400 && s < 500;
async function forAll(cases, fn) {
  const bad = [];
  for (const c of cases) {
    try { const msg = await fn(c); if (msg) bad.push(`${typeof c === 'string' ? c.slice(0, 60) : JSON.stringify(c).slice(0, 80)} -> ${msg}`); }
    catch (e) { bad.push(`${JSON.stringify(c).slice(0, 80)} -> threw ${e.message}`); }
  }
  assert.equal(bad.length, 0, `\n  ${bad.join('\n  ')}`);
}
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---------------------------------------------------------------- global state saved / restored
const ORIGINAL_PRICING = sql(`select value::text from platform_settings where key='plan_prices'`) || null;
const ORIGINAL_CLOCK = (await get('/api/public/clock')).json;
if (!ORIGINAL_CLOCK) throw new Error(`Cannot reach ${BASE}`);
const createdTenants = [];
let sysToken;
const S = async () => {
  if (!sysToken) sysToken = (await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token;
  return sysToken;
};
const sget = async (p) => get(p, { token: await S() });
const spost = async (p, b) => post(p, b, { token: await S() });
const sput = async (p, b) => put(p, b, { token: await S() });
const spatch = async (p, b) => patch(p, b, { token: await S() });
const sdel = async (p) => del(p, { token: await S() });
let T0; // "today" according to the server, fixed at start (the clock is restored after the suite)

after(async () => {
  if (ORIGINAL_PRICING === null) sql(`delete from platform_settings where key='plan_prices'`);
  else sql(`insert into platform_settings (key, value) values ('plan_prices', ${q(ORIGINAL_PRICING)}::jsonb) on conflict (key) do update set value = excluded.value`);
  const tok = await S();
  if (ORIGINAL_CLOCK.simulated) await post('/api/system/clock', { date: ORIGINAL_CLOCK.today }, { token: tok });
  else await del('/api/system/clock', { token: tok });
  if (process.env.QB_TEST_CLEANUP === '1') for (const id of createdTenants) await del(`/api/system/tenants/${id}`, { token: tok });
});
before(async () => {
  T0 = ORIGINAL_CLOCK.today;
});

// ---------------------------------------------------------------- fixtures (all via psql)
function mkTenant({ status = 'active', label = 't', locs = ['Main'], services = 1, locationCount } = {}) {
  const email = `sys-test-${RUN}-${label}-${rnd()}@example.com`;
  const name = `sys-test-${label}-${rnd()}`;
  const id = sql(`insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name,company_address,signup_country)
    values (${q(name)},${q(email)},${locationCount ?? locs.length},${q(code6())},'card',${q(status)},'Sys','Tester','1 Test St, London, N1 1AA','GB') returning id`);
  createdTenants.push(id);
  const t = { id, email, name, locIds: [], locCodes: [], svcIds: [] };
  locs.forEach((ln, i) => {
    const lid = sql(`insert into locations (tenant_id,name,address,staff_access_code) values ('${id}',${q(ln)},'',${q(code6() + '-' + rnd())}) returning id`);
    const code = `QB-${code6()}`;
    sql(`insert into location_codes (code,tenant_id,location_id) values ('${code}','${id}','${lid}')`);
    t.locIds.push(lid); t.locCodes.push(code);
  });
  for (let i = 0; i < services; i++) {
    t.svcIds.push(sql(`insert into services (tenant_id,location_id,name,mode,slot_minutes) values ('${id}','${t.locIds[i % t.locIds.length]}',${q('Svc ' + (i + 1))},'hybrid',15) returning id`));
  }
  return t;
}
// A licence row in any state. `o.start/end` are dates, `o.age` is how many days ago it was purchased.
function mkLic(t, svcIdx, o = {}) {
  const svc = t.svcIds[svcIdx ?? 0];
  const d = { plan_id: 'week', plan_label: 'Week', plan_days: 7, price: 100, status: 'available', payment_method: 'card', paid: true, start: null, end: null, age: 0, ...o };
  const dt = (v) => (v ? q(v) : 'null');
  return sql(`insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status,start_date,end_date,purchased_at,payment_method,paid,paid_at,scheduled_at)
    values ('${t.id}','${svc}',${q(d.plan_id)},${q(d.plan_label)},${d.plan_days},${d.price},${q(d.status)},${dt(d.start)},${dt(d.end)},now() - interval '${d.age} days',${d.payment_method ? q(d.payment_method) : 'null'},${d.paid},${d.paid ? 'now()' : 'null'},${d.status === 'available' ? 'null' : "now() - interval '2 days'"}) returning id`);
}
function mkDay(t, svcIdx, date, hours = [540, 570, 600]) {
  sql(`insert into service_daily_config (service_id,date,hours,staff_count) values ('${t.svcIds[svcIdx ?? 0]}','${date}','{${hours.join(',')}}',2) on conflict do nothing`);
}
function mkStaff(t, first = 'Sam', last = 'Staff') {
  const email = `sys-test-staff-${RUN}-${rnd()}@example.com`;
  const id = sql(`insert into staff_members (tenant_id,first_name,last_name,email) values ('${t.id}',${q(first)},${q(last)},${q(email)}) returning id`);
  return { id, email };
}
async function adminLogin(t) {
  const r = await post('/api/auth/admin/request-otp', { email: t.email });
  assert.equal(r.status, 200, r.text);
  const v = await post('/api/auth/admin/verify-otp', { email: t.email, code: r.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  return v.json.token;
}
async function staffLogin(email) {
  const r = await post('/api/auth/staff/request-otp', { email });
  assert.ok(r.json?.demoOtp, r.text);
  const v = await post('/api/auth/staff/verify-otp', { email, code: r.json.demoOtp });
  assert.equal(v.status, 200, v.text);
  return v.json.token;
}
const audit = (tid) => sqlJson(`select message from audit_log where tenant_id='${tid}' order by created_at, id`).map((r) => r.message);
const licRow = (id) => sqlJson(`select * from service_licenses where id='${id}'`)[0];
const tenantRow = (id) => sqlJson(`select * from tenants where id='${id}'`)[0];
const count = (table, tid) => Number(sql(`select count(*) from ${table} where tenant_id='${tid}'`));
// The money tests compare totals before/after; if earlier runs left absurd prices behind (>1e12) float math can't resolve pennies.
const sane = async (ctx) => { const r = (await sget(`${SYS}/reports/overview`)).json; if (r.totalRevenue > 1e12 || r.pendingRevenue > 1e12) { ctx.skip('qb_test holds absurd prices from earlier runs - reset the database'); return false; } return true; };
const SYS = '/api/system';
const TP = (t) => `${SYS}/tenants/${t.id}`;

// =====================================================================================
// 1. LOGIN & TOKENS
// =====================================================================================
describe('1. System login & tokens', () => {
  it('wrong / empty / missing / odd-cased password -> 401 and no token', async () => {
    for (const body of [{ password: 'nope' }, { password: '' }, {}, { password: 'ADMINPASS' }, { password: ' adminpass' }, { password: 'adminpass ' }, { password: null }]) {
      const r = await post('/api/auth/system/login', body);
      assert.equal(r.status, 401, JSON.stringify(body)); assert.ok(!r.json.token); assert.match(r.json.error, /incorrect/i);
    }
  });
  it('wrongly-typed, oversized and null-byte passwords -> 401, never 500', async () => {
    await forAll([{ password: 123 }, { password: ['adminpass'] }, { password: { a: 1 } }, { password: true }, { password: 'x'.repeat(100000) }, { password: 'a\u0000b' }, { password: '💥'.repeat(300) }], async (b) => {
      const r = await post('/api/auth/system/login', b);
      return r.status === 401 && !r.json?.token ? null : `${r.status} ${r.text.slice(0, 80)}`;
    });
  });
  it('no body / malformed JSON / array body / wrong content-type -> 4xx JSON, no token', async () => {
    const cases = [
      await api('POST', '/api/auth/system/login'),
      await api('POST', '/api/auth/system/login', { rawBody: '{"password":' }),
      await api('POST', '/api/auth/system/login', { rawBody: '["adminpass"]' }),
      await api('POST', '/api/auth/system/login', { rawBody: 'password=adminpass', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      await api('POST', '/api/auth/system/login', { rawBody: JSON.stringify({ password: SYSTEM_PASSWORD }), headers: { 'content-type': 'text/plain' } }),
    ];
    for (const r of cases) { assert.ok(is4xx(r.status), `${r.status} ${r.text}`); assert.ok(r.json && !r.json.token, r.text); }
  });
  it('GET on the login route is not a login', async () => {
    const r = await get('/api/auth/system/login');
    assert.ok(is4xx(r.status)); assert.ok(!r.json?.token);
  });
  it('correct password -> system_admin token, 8h expiry, no tenant claims', async () => {
    const r = await post('/api/auth/system/login', { password: SYSTEM_PASSWORD });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['token']);
    const c = decodeJwt(r.json.token);
    assert.equal(c.role, 'system_admin'); assert.ok(!c.tenantId && !c.staffId);
    assert.ok(Math.abs((c.exp - c.iat) - 8 * 3600) <= 5, `exp-iat=${c.exp - c.iat}`);
    assert.equal((await get(`${SYS}/tenants`, { token: r.json.token })).status, 200);
  });
  it('[S01] repeated wrong passwords from one address are throttled (429 + Retry-After), other addresses unaffected', async () => {
    const ip = `10.${ri(250) + 1}.${ri(250) + 1}.${ri(250) + 1}`;
    let blockedAt = 0; let retryAfter = null;
    for (let i = 1; i <= 40 && !blockedAt; i++) {
      const r = await post('/api/auth/system/login', { password: `guess-${i}` }, { ip });
      if (r.status === 429) { blockedAt = i; retryAfter = r.headers.get('retry-after'); assert.ok(r.json.error); }
      else assert.equal(r.status, 401);
    }
    assert.ok(blockedAt > 0, 'no 429 after 40 wrong passwords: unlimited online password guessing');
    assert.ok(blockedAt <= 30, `first throttled only at attempt ${blockedAt}`);
    assert.ok(Number(retryAfter) > 0, `Retry-After: ${retryAfter}`);
    const other = await post('/api/auth/system/login', { password: SYSTEM_PASSWORD });
    assert.equal(other.status, 200, 'a different address must still be able to sign in');
  });
  it('[S01] a handful of failed attempts followed by the right password still works (no lock-out of normal use)', async () => {
    const ip = randIp();
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/system/login', { password: 'typo' + i }, { ip })).status, 401);
    assert.equal((await post('/api/auth/system/login', { password: SYSTEM_PASSWORD }, { ip })).status, 200);
  });
  it('expired / wrong-secret / alg=none / malformed / role-less tokens -> 401', async () => {
    const good = { role: 'system_admin' };
    const bad = {
      expired: forgeJwt({ ...good, iat: nowSec() - 99999, exp: nowSec() - 60 }),
      wrongSecret: forgeJwt({ ...good, exp: nowSec() + 600 }, { secret: 'not-the-secret' }),
      algNone: forgeJwt({ ...good, exp: nowSec() + 600 }, { alg: 'none' }),
      garbage: 'not.a.jwt', empty: '', roleless: forgeJwt({ exp: nowSec() + 600 }),
    };
    for (const [name, tok] of Object.entries(bad)) {
      const r = await get(`${SYS}/tenants`, { token: tok || undefined });
      assert.ok(r.status === 401 || r.status === 403, `${name}: ${r.status}`);
      assert.ok(!/"tenants"/.test(r.text), name);
    }
    assert.equal((await get(`${SYS}/tenants`, { token: bad.expired })).status, 401);
    assert.equal((await get(`${SYS}/tenants`, { token: bad.wrongSecret })).status, 401);
    assert.equal((await get(`${SYS}/tenants`, { token: bad.algNone })).status, 401);
    assert.equal((await get(`${SYS}/tenants`, { token: bad.roleless })).status, 403);
    assert.equal((await get(`${SYS}/tenants`, { headers: { authorization: 'Basic abc' } })).status, 401);
    assert.equal((await get(`${SYS}/tenants`, { headers: { authorization: `Bearer ${await S()} extra` } })).status, 401);
  });
  it('a correctly-signed token that has not expired yet works (forged with the real secret, same shape as login)', async () => {
    const tok = forgeJwt({ role: 'system_admin', iat: nowSec(), exp: nowSec() + 600 });
    assert.equal((await get(`${SYS}/clock`, { token: tok })).status, 200);
  });
  it('tenant-admin and staff tokens are refused (403) on system routes; system token is refused on tenant routes', async () => {
    const t = mkTenant({ label: 'roles' }); const st = mkStaff(t);
    const adminTok = await adminLogin(t); const staffTok = await staffLogin(st.email);
    for (const tok of [adminTok, staffTok]) {
      for (const [m, p] of [['GET', `${SYS}/tenants`], ['GET', `${TP(t)}/detail`], ['PATCH', TP(t)], ['DELETE', TP(t)], ['GET', `${SYS}/pricing`], ['PUT', `${SYS}/pricing`], ['GET', `${SYS}/reports/overview`], ['GET', `${SYS}/clock`], ['POST', `${SYS}/clock`], ['DELETE', `${SYS}/clock`]]) {
        const r = await api(m, p, { token: tok, body: m === 'GET' || m === 'DELETE' ? undefined : { date: '2030-01-01', status: 'disabled' } });
        assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
      }
    }
    assert.equal(tenantRow(t.id).status, 'active', 'tenant must not have been modified');
    assert.equal((await get('/api/public/clock')).json.simulated, ORIGINAL_CLOCK.simulated, 'clock untouched');
    const sys = await S();
    for (const p of ['/api/tenant/me', '/api/tenant/services', '/api/tenant/locations', '/api/tenant/audit-log']) {
      const r = await get(p, { token: sys });
      assert.ok(r.status === 401 || r.status === 403, `${p} -> ${r.status}`);
    }
  });
  it('every /api/system route requires a system token (401 without / with junk)', async () => {
    const l = UUID0;
    const routes = [
      ['GET', '/tenants'], ['GET', `/tenants/${l}/detail`], ['PATCH', `/tenants/${l}`], ['DELETE', `/tenants/${l}`],
      ['PATCH', `/tenants/${l}/staff/${l}`], ['DELETE', `/tenants/${l}/staff/${l}`],
      ['PATCH', `/tenants/${l}/locations/${l}`], ['DELETE', `/tenants/${l}/locations/${l}`],
      ['PATCH', `/tenants/${l}/services/${l}`], ['DELETE', `/tenants/${l}/services/${l}`],
      ['POST', `/tenants/${l}/services/${l}/licenses/annual`], ['POST', `/tenants/${l}/services/${l}/licenses/free`],
      ['POST', `/tenants/${l}/licenses/${l}/mark-paid`], ['POST', `/tenants/${l}/services/${l}/licenses/${l}/refund`],
      ['GET', '/pricing'], ['PUT', '/pricing'], ['GET', '/reports/overview'], ['GET', '/clock'], ['POST', '/clock'], ['DELETE', '/clock'],
      ['GET', '/does-not-exist'], ['POST', '/tenants'],
    ];
    for (const [m, p] of routes) {
      const none = await api(m, SYS + p, { body: m === 'GET' || m === 'DELETE' ? undefined : {} });
      const junk = await api(m, SYS + p, { token: 'junk', body: m === 'GET' || m === 'DELETE' ? undefined : {} });
      assert.equal(none.status, 401, `${m} ${p} without token -> ${none.status}`);
      assert.equal(junk.status, 401, `${m} ${p} with junk token -> ${junk.status}`);
    }
  });
  it('unknown system routes with a valid token are a JSON 404, not an HTML error page', async () => {
    const r = await sget('/api/system/nope');
    assert.equal(r.status, 404);
  });
});

// =====================================================================================
// 2. TENANT LIST & DETAIL
// =====================================================================================
describe('2. Tenant list & detail', () => {
  let a, b, bLic;
  before(() => {
    a = mkTenant({ label: 'list-a', locs: ['North', 'South'], services: 2 });
    b = mkTenant({ label: 'list-b', status: 'pending' });
    mkLic(a, 0, { price: 100 }); mkLic(a, 0, { price: 50, paid: false, payment_method: 'invoice' }); mkLic(a, 1, { price: 600, status: 'refunded', plan_id: 'year' });
    bLic = mkLic(b, 0, { price: 200, plan_id: 'month', paid: false, payment_method: 'invoice' });
  });
  it('list: newest first, includes our fixtures with service_count / total_spend / unpaid_count reconciled to the licences', async () => {
    const r = await sget(`${SYS}/tenants`);
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.json.tenants));
    const ra = r.json.tenants.find((t) => t.id === a.id); const rb = r.json.tenants.find((t) => t.id === b.id);
    assert.ok(ra && rb);
    assert.equal(Number(ra.service_count), 1, 'only services with a non-refunded licence are counted');
    assert.equal(Number(ra.total_spend), 150, 'refunded licence excluded from spend');
    assert.equal(Number(ra.unpaid_count), 1);
    assert.equal(Number(rb.total_spend), 200); assert.equal(Number(rb.unpaid_count), 1); assert.equal(rb.status, 'pending');
    const times = r.json.tenants.map((t) => Date.parse(t.created_at));
    assert.ok(times.every((v, i) => i === 0 || times[i - 1] >= v), 'ordered by created_at desc');
  });
  it('list: a tenant with nothing bought reports zeros (not null / NaN)', async () => {
    const c = mkTenant({ label: 'list-c' });
    const row = (await sget(`${SYS}/tenants`)).json.tenants.find((t) => t.id === c.id);
    assert.equal(Number(row.service_count), 0); assert.equal(Number(row.total_spend), 0); assert.equal(Number(row.unpaid_count), 0);
  });
  it('detail: locations, services, licences (with service_name + modeLocked) and staff for the right tenant only', async () => {
    const st = mkStaff(a, 'Zed', 'Zulu'); mkStaff(a, 'Amy', 'Alpha');
    const r = await sget(`${TP(a)}/detail`);
    assert.equal(r.status, 200);
    const d = r.json;
    assert.equal(d.tenant.id, a.id);
    assert.deepEqual(d.locations.map((l) => l.name).sort(), ['North', 'South']);
    assert.ok(d.locations.every((l) => l.code), 'location code included');
    assert.equal(d.services.length, 2);
    assert.ok(d.services.every((s) => s.tenant_id === a.id && typeof s.modeLocked === 'boolean'));
    assert.equal(d.licenses.length, 3);
    assert.ok(d.licenses.every((l) => l.tenant_id === a.id && l.service_name));
    assert.deepEqual(d.staff.map((s) => s.first_name), ['Amy', 'Zed'], 'staff sorted by name');
    assert.ok(d.staff.some((s) => s.id === st.id));
    assert.ok(!JSON.stringify(d).includes(b.id) && !JSON.stringify(d).includes(b.name), 'no other tenant data');
  });
  it('detail: modeLocked is false for a never-live service and true once it has a day with hours or a scheduled licence', async () => {
    const c = mkTenant({ label: 'lock', services: 2 });
    mkLic(c, 0); mkLic(c, 1, { status: 'scheduled', start: addDays(T0, 20), end: addDays(T0, 26) });
    let d = (await sget(`${TP(c)}/detail`)).json;
    assert.equal(d.services.find((s) => s.id === c.svcIds[0]).modeLocked, false);
    assert.equal(d.services.find((s) => s.id === c.svcIds[1]).modeLocked, true);
    mkDay(c, 0, addDays(T0, 3));
    d = (await sget(`${TP(c)}/detail`)).json;
    assert.equal(d.services.find((s) => s.id === c.svcIds[0]).modeLocked, true);
  });
  it('detail: an unknown tenant is 404, a malformed id is 404 (never 500)', async () => {
    assert.equal((await sget(`${SYS}/tenants/${UUID0}/detail`)).status, 404);
    for (const bad of ['not-a-uuid', '123', '%00', "1'or'1'='1", 'x'.repeat(500), UUID0.toUpperCase().slice(0, 35)]) {
      const r = await sget(`${SYS}/tenants/${encodeURIComponent(bad)}/detail`);
      assert.ok(r.status === 404, `${bad.slice(0, 30)} -> ${r.status}`);
    }
  });
  it('no secrets leak: no password hash, JWT, OTP codes or patient ticket tokens in list or detail', async () => {
    sql(`insert into admin_otp (tenant_id,code,expires_at) values ('${a.id}','ZQX987', now() + interval '10 minutes')`);
    sql(`insert into staff_otp (tenant_id,code,expires_at) values ('${a.id}','WVU654', now() + interval '10 minutes')`);
    const blob = (await sget(`${SYS}/tenants`)).text + (await sget(`${TP(a)}/detail`)).text;
    assert.ok(!/\$2[aby]\$/.test(blob), 'bcrypt hash'); assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(blob), 'jwt');
    assert.ok(!blob.includes(JWT_SECRET)); assert.ok(!blob.includes('ZQX987') && !blob.includes('WVU654'), 'otp codes');
    assert.ok(!/password/i.test(blob), 'password field');
  });
  it('responses are not cacheable and carry no framework banner', async () => {
    const r = await sget(`${SYS}/tenants`);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.match(r.headers.get('cache-control') || '', /no-store/, `[S02] Cache-Control: ${r.headers.get('cache-control')}`);
  });
});

// =====================================================================================
// 3. PATCH TENANT (profile + status)
// =====================================================================================
describe('3. PATCH tenant', () => {
  let t;
  before(() => { t = mkTenant({ label: 'patch', locs: ['One'] }); });
  it('updates every editable field, trims text, and returns the row', async () => {
    const r = await spatch(TP(t), { businessName: '  New Name  ', firstName: 'Fay', lastName: 'Lee', email: `sys-test-${RUN}-new-${rnd()}@example.com`, companyAddress: '9 High St, Leeds, LS1 1AA', locationCount: 7 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tenant.business_name, 'New Name'); assert.equal(r.json.tenant.first_name, 'Fay');
    assert.equal(r.json.tenant.location_count, 7); assert.equal(r.json.tenant.company_address, '9 High St, Leeds, LS1 1AA');
    assert.equal(tenantRow(t.id).business_name, 'New Name');
  });
  it('an empty body, unknown fields and payment-method style fields change nothing and do not error', async () => {
    const before = tenantRow(t.id);
    for (const body of [{}, { nonsense: 1 }, { paymentMethod: 'later', payment_method: 'later', access_code: 'HACKED', id: UUID0, created_at: '2000-01-01' }]) {
      const r = await spatch(TP(t), body);
      assert.equal(r.status, 200, r.text);
    }
    const after = tenantRow(t.id);
    for (const k of ['payment_method', 'access_code', 'id', 'created_at']) assert.equal(after[k], before[k], k);
  });
  it('company address can be cleared with an empty string', async () => {
    assert.equal((await spatch(TP(t), { companyAddress: '' })).status, 200);
    assert.equal(tenantRow(t.id).company_address, '');
  });
  it('rejects invalid values with 400 and leaves the row untouched', async () => {
    const before = JSON.stringify(tenantRow(t.id));
    const bodies = [
      { businessName: '' }, { businessName: '   ' }, { businessName: 'x'.repeat(201) }, { businessName: 5 }, { businessName: ['a'] }, { businessName: { a: 1 } }, { businessName: 'a\u0000b' },
      { firstName: '' }, { firstName: 'x'.repeat(101) }, { lastName: true },
      { email: 'not-an-email' }, { email: 'a@b' }, { email: ' ' }, { email: 12 }, { email: `${'x'.repeat(250)}@e.com` },
      { companyAddress: 'x'.repeat(501) }, { companyAddress: 7 },
      { locationCount: -1 }, { locationCount: 1.5 }, { locationCount: '3' }, { locationCount: 100001 }, { locationCount: [1] },
      { status: 'banned' }, { status: 'ACTIVE' }, { status: 1 }, { status: true }, { status: ['active'] }, { status: '' },
    ];
    await forAll(bodies, async (b) => { const r = await spatch(TP(t), b); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 80)}`; });
    assert.equal(JSON.stringify(tenantRow(t.id)), before);
  });
  it('changing the email to one another account already uses is a 409 (case-insensitive)', async () => {
    const other = mkTenant({ label: 'patch-other' });
    for (const email of [other.email, other.email.toUpperCase()]) {
      const r = await spatch(TP(t), { email });
      assert.equal(r.status, 409, r.text);
    }
  });
  it('unknown tenant / malformed id -> 404', async () => {
    assert.equal((await spatch(`${SYS}/tenants/${UUID0}`, { status: 'active' })).status, 404);
    assert.equal((await spatch(`${SYS}/tenants/garbage`, { status: 'active' })).status, 404);
  });
  it('status can move between pending, active and disabled in any direction', async () => {
    for (const s of ['pending', 'active', 'disabled', 'pending', 'disabled', 'active']) {
      const r = await spatch(TP(t), { status: s });
      assert.equal(r.status, 200, `${s}: ${r.text}`); assert.equal(r.json.tenant.status, s); assert.equal(tenantRow(t.id).status, s);
    }
  });
  it('[S03] every status change is written to the tenant audit log, with a message that matches what happened', async () => {
    const c = mkTenant({ label: 'audit-status', status: 'disabled' });
    await spatch(TP(c), { status: 'active' });
    let log = audit(c.id);
    assert.equal(log.length, 1, JSON.stringify(log));
    assert.doesNotMatch(log[0], /invoice payment/i, `re-enabling a disabled account is not an invoice payment: "${log[0]}"`);
    assert.match(log[0], /enabled|re-enabled|active/i);
    await spatch(TP(c), { status: 'disabled' });
    assert.match(audit(c.id).at(-1), /disabled/i);
    await spatch(TP(c), { status: 'pending' });
    assert.equal(audit(c.id).length, 3, 'moving to pending is a system action too');
    await spatch(TP(c), { status: 'active' });
    assert.match(audit(c.id).at(-1), /invoice payment|confirmed|active/i);
  });
  it('[S03] a no-op status "change" does not add a misleading audit entry', async () => {
    const c = mkTenant({ label: 'audit-noop' });
    await spatch(TP(c), { status: 'active' });
    assert.equal(audit(c.id).length, 0, JSON.stringify(audit(c.id)));
  });
  it('[S03] editing the account profile is recorded in the audit log', async () => {
    const c = mkTenant({ label: 'audit-profile' });
    await spatch(TP(c), { businessName: 'Renamed By Platform', locationCount: 3 });
    const log = audit(c.id);
    assert.ok(log.some((m) => /platform admin|our team/i.test(m)), JSON.stringify(log));
  });
});

// =====================================================================================
// 4. DISABLED TENANTS ARE REALLY LOCKED OUT
// =====================================================================================
describe('4. Disabling a tenant', () => {
  let t, st, adminTok, staffTok, svcId, locId;
  before(async () => {
    t = mkTenant({ label: 'disable', locs: ['Front'] }); st = mkStaff(t);
    svcId = t.svcIds[0]; locId = t.locIds[0];
    mkLic(t, 0, { status: 'active', start: T0, end: addDays(T0, 6) }); mkDay(t, 0, T0, [0, 30, 60, 540, 570, 600, 1200, 1230, 1260]);
    adminTok = await adminLogin(t); staffTok = await staffLogin(st.email);
    sql(`insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,hour_block,visit_date) values ('${t.id}','${svcId}','${locId}','A001','walk_in','waiting',540,'${T0}')`);
  });
  it('before disabling: admin, staff and the patient pages all work', async () => {
    assert.equal((await get('/api/tenant/me', { token: adminTok })).status, 200);
    assert.equal((await get('/api/tenant/me', { token: staffTok })).status, 200);
    assert.equal((await get(`/api/public/tenant/${t.id}/info`)).status, 200);
    assert.equal((await get(`/api/public/tenant/${t.id}/services`)).status, 200);
  });
  it('disabling blocks already-issued admin and staff tokens, new sign-ins, and every patient endpoint', async () => {
    assert.equal((await spatch(TP(t), { status: 'disabled' })).status, 200);
    assert.equal((await get('/api/tenant/me', { token: adminTok })).status, 403);
    assert.equal((await get('/api/tenant/services', { token: adminTok })).status, 403);
    assert.equal((await get('/api/tenant/me', { token: staffTok })).status, 403);
    assert.equal((await post('/api/tenant/call-next', { serviceId: svcId }, { token: staffTok })).status, 403);
    // CHANGED (account enumeration): new sign-ins for a disabled account get the same answers as an unknown address (200 with no code / 401)
    // instead of 403, and no sign-in code is issued; tokens already issued are still refused with 403 (above).
    const rqA = await post('/api/auth/admin/request-otp', { email: t.email }); assert.equal(rqA.status, 200); assert.equal(rqA.json.demoOtp, undefined);
    const rqS = await post('/api/auth/staff/request-otp', { email: st.email }); assert.equal(rqS.status, 200); assert.equal(rqS.json.demoOtp, undefined);
    assert.equal((await post('/api/auth/admin/verify-otp', { email: t.email, code: '000000' })).status, 401);
    const su = await signupV(post, { businessName: 'x', firstName: 'a', lastName: 'b', email: t.email, locations: [{ name: 'a' }], services: [{ name: 'b', locationIndex: 0 }] });
    assert.ok([200, 400, 401].includes(su.status), `signup with the disabled account's email -> ${su.status}`);
    assert.equal(su.json?.demoOtp, undefined, 'no code is issued for a disabled account');
    const P = `/api/public/tenant/${t.id}`;
    assert.equal((await get(`${P}/info`)).status, 404);
    assert.equal((await get(`${P}/locations`)).status, 404);
    assert.equal((await get(`${P}/services`)).status, 404);
    assert.equal((await get(`${P}/services/${svcId}/availability?date=${T0}&clockMinutes=541`)).status, 404);
    const join = await post(`${P}/services/${svcId}/tickets`, { type: 'walk_in', date: T0, hourBlock: 540 });
    assert.equal(join.status, 404, join.text);
    assert.equal(Number(sql(`select count(*) from tickets where tenant_id='${t.id}'`)), 1, 'no ticket may be created for a disabled tenant');
  });
  it('[S04] a location code of a disabled tenant no longer resolves (nothing about the business is revealed)', async () => {
    const r = await get(`/api/public/code/${t.locCodes[0]}`);
    assert.equal(r.status, 404, `${r.status} ${r.text}`);
    assert.ok(!r.text.includes(t.name));
  });
  it('re-enabling restores the very same tokens and the patient pages', async () => {
    assert.equal((await spatch(TP(t), { status: 'active' })).status, 200);
    assert.equal((await get('/api/tenant/me', { token: adminTok })).status, 200);
    assert.equal((await get('/api/tenant/me', { token: staffTok })).status, 200);
    assert.equal((await get(`/api/public/tenant/${t.id}/info`)).status, 200);
    assert.equal((await get(`/api/public/code/${t.locCodes[0]}`)).status, 200);
  });
  it('pending tenants keep working like active ones for sign-in (only disabled is blocked)', async () => {
    await spatch(TP(t), { status: 'pending' });
    assert.equal((await get('/api/tenant/me', { token: adminTok })).status, 200);
    assert.equal((await get(`/api/public/tenant/${t.id}/info`)).json.status, 'pending');
    await spatch(TP(t), { status: 'active' });
  });
});

// =====================================================================================
// 5. STAFF
// =====================================================================================
describe('5. Staff', () => {
  let a, b, sa, sb;
  before(() => { a = mkTenant({ label: 'staff-a' }); b = mkTenant({ label: 'staff-b' }); sa = mkStaff(a, 'Ann', 'Able'); sb = mkStaff(b, 'Bob', 'Baker'); });
  it('PATCH updates names and email, returns only safe fields, and records an audit entry', async () => {
    const email = `sys-test-${RUN}-ann-${rnd()}@example.com`;
    const r = await spatch(`${TP(a)}/staff/${sa.id}`, { firstName: ' Anna ', lastName: 'Ablet', email });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.staff).sort(), ['created_at', 'email', 'first_name', 'id', 'last_name']);
    assert.equal(r.json.staff.first_name, 'Anna'); assert.equal(r.json.staff.email, email);
    assert.ok(audit(a.id).some((m) => /Staff user updated by platform admin: Anna Ablet/.test(m)), JSON.stringify(audit(a.id)));
    sa.email = email;
  });
  it('PATCH with an empty body is a harmless no-op', async () => {
    const r = await spatch(`${TP(a)}/staff/${sa.id}`, {});
    assert.equal(r.status, 200); assert.equal(r.json.staff.first_name, 'Anna');
  });
  it('PATCH validation: blank / wrong-typed / oversized / bad email -> 400, duplicate email (any case, any tenant) -> 409', async () => {
    await forAll([{ firstName: '' }, { lastName: ' ' }, { firstName: 9 }, { lastName: ['x'] }, { firstName: 'x'.repeat(101) }, { email: 'nope' }, { email: 5 }, { email: 'a b@c.de' }, { email: `${'x'.repeat(250)}@e.com` }, { email: '' }],
      async (b2) => { const r = await spatch(`${TP(a)}/staff/${sa.id}`, b2); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 80)}`; });
    const sa2 = mkStaff(a, 'Cy', 'Cole');
    for (const email of [sa2.email, sa2.email.toUpperCase(), sb.email]) {
      const r = await spatch(`${TP(a)}/staff/${sa.id}`, { email });
      assert.equal(r.status, 409, `${email} -> ${r.status} ${r.text}`);
    }
    assert.equal(sqlJson(`select email from staff_members where id='${sa.id}'`)[0].email, sa.email);
    const same = await spatch(`${TP(a)}/staff/${sa.id}`, { email: sa.email.toUpperCase() });
    assert.equal(same.status, 200, 'changing only the case of your own email is fine');
  });
  it('cross-tenant ids: staff of B through tenant A (and vice versa) -> 404 and nothing changes', async () => {
    const r1 = await spatch(`${TP(a)}/staff/${sb.id}`, { firstName: 'Hacked' });
    const r2 = await sdel(`${TP(a)}/staff/${sb.id}`);
    const r3 = await spatch(`${SYS}/tenants/${UUID0}/staff/${sa.id}`, { firstName: 'Hacked' });
    const r4 = await sdel(`${TP(a)}/staff/${UUID0}`);
    for (const r of [r1, r2, r3, r4]) assert.equal(r.status, 404, r.text);
    assert.equal(sqlJson(`select first_name from staff_members where id='${sb.id}'`)[0].first_name, 'Bob');
    assert.equal(count('staff_members', b.id), 1);
  });
  it('malformed ids -> 404', async () => {
    for (const p of [`${TP(a)}/staff/nope`, `${SYS}/tenants/nope/staff/${sa.id}`]) {
      assert.equal((await spatch(p, { firstName: 'x' })).status, 404); assert.equal((await sdel(p)).status, 404);
    }
  });
  it('DELETE removes the member, ends their live session at once, audits it, and is 404 when repeated', async () => {
    const m = mkStaff(a, 'Dee', 'Dunn'); const tok = await staffLogin(m.email);
    assert.equal((await get('/api/tenant/me', { token: tok })).status, 200);
    const d = await sdel(`${TP(a)}/staff/${m.id}`);
    assert.equal(d.status, 200); assert.deepEqual(d.json, { ok: true });
    assert.equal((await get('/api/tenant/me', { token: tok })).status, 401, 'deleted staff keep a working session');
    assert.equal((await post('/api/auth/staff/request-otp', { email: m.email })).json.demoOtp, undefined);
    assert.ok(audit(a.id).some((x) => /Staff user removed by platform admin: Dee Dunn/.test(x)));
    assert.equal((await sdel(`${TP(a)}/staff/${m.id}`)).status, 404);
  });
  it('an edited staff email takes effect for sign-in (old address is dead)', async () => {
    const m = mkStaff(a, 'Eve', 'Ellis'); const old = m.email; const fresh = `sys-test-${RUN}-eve-${rnd()}@example.com`;
    assert.equal((await spatch(`${TP(a)}/staff/${m.id}`, { email: fresh })).status, 200);
    assert.equal((await post('/api/auth/staff/request-otp', { email: old })).json.demoOtp, undefined);
    assert.ok((await post('/api/auth/staff/request-otp', { email: fresh })).json.demoOtp);
  });
});

// =====================================================================================
// 6. LOCATIONS & SERVICES
// =====================================================================================
describe('6. Locations', () => {
  let a, b;
  before(() => { a = mkTenant({ label: 'loc-a', locs: ['North', 'South'], services: 2 }); b = mkTenant({ label: 'loc-b', locs: ['Other'] }); });
  it('PATCH renames / re-addresses a location (trimmed) and returns the row; empty address allowed', async () => {
    const r = await spatch(`${TP(a)}/locations/${a.locIds[0]}`, { name: '  Northern  ', address: '1 Road' });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.location.name, 'Northern'); assert.equal(r.json.location.address, '1 Road');
    const c = await spatch(`${TP(a)}/locations/${a.locIds[0]}`, { address: '' });
    assert.equal(c.json.location.address, '');
    assert.equal((await spatch(`${TP(a)}/locations/${a.locIds[0]}`, {})).status, 200);
  });
  it('PATCH validation: blank, wrong-typed, oversized, null byte -> 400', async () => {
    await forAll([{ name: '' }, { name: '  ' }, { name: 1 }, { name: ['x'] }, { name: { a: 1 } }, { name: 'x'.repeat(201) }, { name: 'a\u0000' }, { address: 5 }, { address: 'x'.repeat(501) }],
      async (b2) => { const r = await spatch(`${TP(a)}/locations/${a.locIds[0]}`, b2); return r.status === 400 ? null : `${r.status}`; });
  });
  it('cross-tenant / unknown / malformed location ids -> 404 on PATCH', async () => {
    for (const p of [`${TP(a)}/locations/${b.locIds[0]}`, `${TP(b)}/locations/${a.locIds[0]}`, `${TP(a)}/locations/${UUID0}`, `${TP(a)}/locations/bad`, `${SYS}/tenants/${UUID0}/locations/${a.locIds[0]}`]) {
      assert.equal((await spatch(p, { name: 'Hijacked' })).status, 404, p);
    }
    assert.equal(sqlJson(`select name from locations where id='${b.locIds[0]}'`)[0].name, 'Other');
  });
  it('[S05] DELETE with a mismatching / unknown location answers 404 (not "ok") and deletes nothing', async () => {
    for (const p of [`${TP(a)}/locations/${b.locIds[0]}`, `${TP(b)}/locations/${a.locIds[0]}`, `${TP(a)}/locations/${UUID0}`, `${SYS}/tenants/${UUID0}/locations/${a.locIds[0]}`]) {
      const r = await sdel(p);
      assert.equal(r.status, 404, `${p} -> ${r.status} ${r.text}`);
    }
    assert.equal(count('locations', b.id), 1); assert.equal(count('locations', a.id), 2);
    assert.equal((await sdel(`${TP(a)}/locations/nope`)).status, 404);
  });
  it('DELETE cascades to the location\'s services, licences, daily hours, tickets and code, and audits it', async () => {
    const c = mkTenant({ label: 'loc-del', locs: ['Keep', 'Drop'], services: 2 });
    mkLic(c, 0); mkLic(c, 1); mkDay(c, 1, addDays(T0, 2));
    sql(`insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,visit_date) values ('${c.id}','${c.svcIds[1]}','${c.locIds[1]}','B001','walk_in','waiting','${T0}')`);
    const r = await sdel(`${TP(c)}/locations/${c.locIds[1]}`);
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    assert.equal(count('locations', c.id), 1); assert.equal(count('services', c.id), 1);
    assert.equal(count('service_licenses', c.id), 1); assert.equal(count('tickets', c.id), 0);
    assert.equal(Number(sql(`select count(*) from service_daily_config where service_id='${c.svcIds[1]}'`)), 0);
    assert.equal(Number(sql(`select count(*) from location_codes where location_id='${c.locIds[1]}'`)), 0);
    assert.ok(audit(c.id).some((m) => /Drop/.test(m) && /platform admin/i.test(m)), `[S03] location deletion is not audited: ${JSON.stringify(audit(c.id))}`);
    assert.equal((await sdel(`${TP(c)}/locations/${c.locIds[1]}`)).status, 404, 'repeat delete');
  });
  it('[S06] deleting a location keeps the tenant\'s location count (billing / reports total) in step', async () => {
    const c = mkTenant({ label: 'loc-count', locs: ['A', 'B', 'C'], services: 3 });
    assert.equal(tenantRow(c.id).location_count, 3);
    await sdel(`${TP(c)}/locations/${c.locIds[2]}`);
    assert.equal(tenantRow(c.id).location_count, 2, 'location_count still 3 after deleting one of three locations');
    const d = mkTenant({ label: 'loc-count0', locs: ['Z'], locationCount: 0 });
    await sdel(`${TP(d)}/locations/${d.locIds[0]}`);
    assert.equal(tenantRow(d.id).location_count, 0, 'never negative');
  });
  it('[S03] renaming a location is audited', async () => {
    const c = mkTenant({ label: 'loc-audit' });
    await spatch(`${TP(c)}/locations/${c.locIds[0]}`, { name: 'Renamed' });
    assert.ok(audit(c.id).some((m) => /Renamed/.test(m) && /platform admin/i.test(m)), JSON.stringify(audit(c.id)));
  });
});

describe('7. Services', () => {
  let a, b;
  before(() => { a = mkTenant({ label: 'svc-a', locs: ['North'], services: 2 }); b = mkTenant({ label: 'svc-b', locs: ['Other'] }); });
  const SP = (t, i) => `${TP(t)}/services/${t.svcIds[i ?? 0]}`;
  it('PATCH changes name / mode / slot length / archived on a never-live service', async () => {
    const r = await spatch(SP(a), { name: ' Renamed ', mode: 'appointment', slotMinutes: 30, archived: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.service.name, r.json.service.mode, r.json.service.slot_minutes, r.json.service.archived], ['Renamed', 'appointment', 30, true]);
    const r2 = await spatch(SP(a), { slotMinutes: '10', archived: false });
    assert.equal(r2.status, 200, r2.text); assert.equal(r2.json.service.slot_minutes, 10); assert.equal(r2.json.service.archived, false);
    assert.equal((await spatch(SP(a), {})).status, 200);
  });
  it('PATCH validation: bad mode / slot / name / archived -> 400', async () => {
    await forAll([{ mode: 'walkin' }, { mode: 'QUEUE' }, { mode: 3 }, { mode: [] }, { slotMinutes: 7 }, { slotMinutes: 0 }, { slotMinutes: -5 }, { slotMinutes: 1441 }, { slotMinutes: 15.5 }, { slotMinutes: 'abc' }, { slotMinutes: '' }, { slotMinutes: [15] }, { slotMinutes: 2 },
      { name: '' }, { name: 5 }, { name: 'x'.repeat(201) }, { archived: 'true' }, { archived: 1 }, { archived: 'yes' }],
      async (b2) => { const r = await spatch(SP(a), b2); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 60)}`; });
  });
  it('type / slot length are locked (409) once a licence is scheduled, active or expired, or a day has hours; archiving and renaming still work', async () => {
    for (const [label, setup] of [
      ['scheduled', (t) => mkLic(t, 0, { status: 'scheduled', start: addDays(T0, 30), end: addDays(T0, 36) })],
      ['expired', (t) => mkLic(t, 0, { status: 'expired', start: addDays(T0, -30), end: addDays(T0, -24) })],
      ['hours', (t) => { mkLic(t, 0); mkDay(t, 0, addDays(T0, 5)); }],
    ]) {
      const c = mkTenant({ label: `svc-lock-${label}` }); setup(c);
      const m = await spatch(SP(c), { mode: 'queue' }); assert.equal(m.status, 409, `${label} mode: ${m.text}`);
      const s = await spatch(SP(c), { slotMinutes: 60 }); assert.equal(s.status, 409, `${label} slot: ${s.text}`);
      assert.equal((await spatch(SP(c), { mode: 'hybrid', slotMinutes: 15 })).status, 200, `${label}: unchanged values are accepted`);
      assert.equal((await spatch(SP(c), { name: 'Still renamable', archived: true })).status, 200);
    }
  });
  it('a refunded-only history does not lock the service', async () => {
    const c = mkTenant({ label: 'svc-refunded' }); mkLic(c, 0, { status: 'refunded' });
    assert.equal((await spatch(SP(c), { mode: 'queue' })).status, 200);
  });
  it('cross-tenant / unknown / malformed service ids -> 404 for PATCH (with or without mode fields)', async () => {
    for (const body of [{ name: 'X' }, { mode: 'queue' }, { slotMinutes: 5 }, { archived: true }]) {
      for (const p of [`${TP(a)}/services/${b.svcIds[0]}`, `${TP(b)}/services/${a.svcIds[0]}`, `${TP(a)}/services/${UUID0}`, `${TP(a)}/services/bad`]) {
        assert.equal((await spatch(p, body)).status, 404, `${JSON.stringify(body)} ${p}`);
      }
    }
    assert.equal(sqlJson(`select name,mode,archived from services where id='${b.svcIds[0]}'`)[0].name, 'Svc 1');
  });
  it('[S05] DELETE with a mismatching / unknown service answers 404 (not "ok") and deletes nothing', async () => {
    for (const p of [`${TP(a)}/services/${b.svcIds[0]}`, `${TP(b)}/services/${a.svcIds[0]}`, `${TP(a)}/services/${UUID0}`]) {
      const r = await sdel(p); assert.equal(r.status, 404, `${p} -> ${r.status} ${r.text}`);
    }
    assert.equal(count('services', b.id), 1); assert.equal(count('services', a.id), 2);
    assert.equal((await sdel(`${TP(a)}/services/bad`)).status, 404);
  });
  it('DELETE cascades to licences, hours and tickets, audits it, and a repeat is 404', async () => {
    const c = mkTenant({ label: 'svc-del', services: 2 }); mkLic(c, 0); mkLic(c, 1); mkDay(c, 0, addDays(T0, 2));
    sql(`insert into tickets (tenant_id,service_id,location_id,ticket_number,type,status,visit_date) values ('${c.id}','${c.svcIds[0]}','${c.locIds[0]}','C001','walk_in','waiting','${T0}')`);
    const r = await sdel(SP(c, 0)); assert.equal(r.status, 200);
    assert.equal(count('services', c.id), 1); assert.equal(count('service_licenses', c.id), 1); assert.equal(count('tickets', c.id), 0);
    assert.equal(Number(sql(`select count(*) from service_daily_config where service_id='${c.svcIds[0]}'`)), 0);
    assert.ok(audit(c.id).some((m) => /Svc 1/.test(m) && /platform admin/i.test(m)), `[S03] service deletion is not audited: ${JSON.stringify(audit(c.id))}`);
    assert.equal((await sdel(SP(c, 0))).status, 404);
  });
  it('[S03] editing a service (rename / archive / type) is audited', async () => {
    const c = mkTenant({ label: 'svc-audit' });
    await spatch(SP(c), { name: 'Audited Name', archived: true });
    assert.ok(audit(c.id).some((m) => /Audited Name/.test(m) && /platform admin/i.test(m)), JSON.stringify(audit(c.id)));
  });
});

// =====================================================================================
// 8. LICENCES
// =====================================================================================
describe('8. Licences: annual / free', () => {
  let a, b;
  before(() => { a = mkTenant({ label: 'lic-a', services: 2, locs: ['L1'] }); b = mkTenant({ label: 'lic-b' }); });
  const AN = (t, i) => `${TP(t)}/services/${t.svcIds[i ?? 0]}/licenses/annual`;
  const FR = (t, i) => `${TP(t)}/services/${t.svcIds[i ?? 0]}/licenses/free`;
  it('annual: creates an unpaid invoice licence at the agreed price (365 days, available, ex-VAT price stored as given)', async () => {
    const r = await spost(AN(a), { price: 1234.5 });
    assert.equal(r.status, 200, r.text);
    const l = r.json.license;
    assert.equal(l.plan_id, 'year'); assert.equal(l.plan_days, 365); assert.equal(Number(l.price), 1234.5);
    assert.equal(l.status, 'available'); assert.equal(l.paid, false); assert.equal(l.payment_method, 'invoice');
    assert.equal(l.service_name, 'Svc 1'); assert.equal(l.tenant_id, a.id); assert.equal(l.service_id, a.svcIds[0]);
    assert.ok(audit(a.id).some((m) => /Annual license added by platform admin for "Svc 1" at agreed price £1234\.50/.test(m)), JSON.stringify(audit(a.id)));
  });
  it('[S07] annual: accepts plain decimal strings, rejects everything else (hex, exponent, spaces, non-numbers) with 400', async () => {
    assert.equal((await spost(AN(a), { price: '99.99' })).status, 200);
    assert.equal((await spost(AN(a), { price: 1000000 })).status, 200);
    await forAll([{}, { price: 0 }, { price: -5 }, { price: 1000001 }, { price: 'abc' }, { price: '' }, { price: null }, { price: true }, { price: [5] }, { price: { a: 1 } }, { price: '1e999' }, { price: 'Infinity' }, { price: '1'.repeat(25) }, { price: 1e999 }, { price: '0x10' }, { price: '1e3' }, { price: ' 50' }, { price: '5 0' }, { price: '+5' }, { price: '5.' }, { price: '.5' }],
      async (body) => {
        const n = count('service_licenses', a.id);
        const r = await spost(AN(a), body); if (r.status !== 400) return `${r.status} ${r.text.slice(0, 80)}`;
        return count('service_licenses', a.id) === n ? null : 'a licence was created anyway';
      });
  });
  it('[S07] annual: a price with more than 2 decimals is rejected rather than silently rounded to a different amount', async () => {
    const r = await spost(AN(a), { price: 100.005 });
    assert.equal(r.status, 400, `${r.status} ${r.text}`);
    const r2 = await spost(AN(a), { price: 19.999 });
    assert.equal(r2.status, 400, `${r2.status} ${r2.text}`);
  });
  it('annual / free: wrong tenant / service / malformed ids -> 404 and nothing is created', async () => {
    const n = count('service_licenses', b.id) + count('service_licenses', a.id);
    for (const [fn, body] of [[AN, { price: 100 }], [FR, { planId: 'week' }]]) {
      for (const p of [`${TP(a)}/services/${b.svcIds[0]}/licenses/${fn === AN ? 'annual' : 'free'}`, `${TP(b)}/services/${a.svcIds[0]}/licenses/${fn === AN ? 'annual' : 'free'}`, `${TP(a)}/services/${UUID0}/licenses/${fn === AN ? 'annual' : 'free'}`, `${TP(a)}/services/bad/licenses/${fn === AN ? 'annual' : 'free'}`]) {
        assert.equal((await spost(p, body)).status, 404, p);
      }
    }
    assert.equal(count('service_licenses', b.id) + count('service_licenses', a.id), n);
  });
  it('free: each fixed plan grants a £0 available licence labelled as a grant, with the right length', async () => {
    for (const [planId, days] of [['day', 1], ['week', 7], ['month', 30], ['year', 365]]) {
      const r = await spost(FR(a, 1), { planId });
      assert.equal(r.status, 200, `${planId}: ${r.text}`);
      const l = r.json.license;
      assert.equal(l.plan_id, planId); assert.equal(l.plan_days, days); assert.equal(Number(l.price), 0);
      assert.equal(l.status, 'available'); assert.match(l.plan_label, /free — granted/); assert.equal(l.paid, true);
      assert.equal(l.service_name, 'Svc 2');
    }
    assert.ok(audit(a.id).some((m) => /Free license granted by platform admin for "Svc 2" — Week \(7 days\)/.test(m)));
  });
  it('free: custom plans accept 1..365 whole days (number or digit string)', async () => {
    for (const [d, exp] of [[1, 1], [365, 365], ['14', 14], [90, 90]]) {
      const r = await spost(FR(a), { planId: 'custom', customDays: d });
      assert.equal(r.status, 200, `${d}: ${r.text}`); assert.equal(r.json.license.plan_days, exp); assert.equal(Number(r.json.license.price), 0);
    }
  });
  it('free: unknown plans and bad custom days -> 400, no licence created', async () => {
    const n = count('service_licenses', a.id);
    await forAll([{}, { planId: 'trial' }, { planId: 'decade' }, { planId: 'constructor' }, { planId: '__proto__' }, { planId: 'toString' }, { planId: 5 }, { planId: null }, { planId: ['week'] }, { planId: { a: 1 } }, { planId: 'WEEK' },
      { planId: 'custom' }, { planId: 'custom', customDays: 0 }, { planId: 'custom', customDays: 366 }, { planId: 'custom', customDays: -3 }, { planId: 'custom', customDays: 1.5 }, { planId: 'custom', customDays: 'abc' }, { planId: 'custom', customDays: '' }, { planId: 'custom', customDays: null }, { planId: 'custom', customDays: [7] }, { planId: 'custom', customDays: 1e9 }, { planId: 'custom', customDays: '99999999' }],
      async (body) => { const r = await spost(FR(a), body); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 80)}`; });
    assert.equal(count('service_licenses', a.id), n);
  });
  it('free: still free (and valid) while a sale or a half-configured price table is saved', async () => {
    sql(`insert into platform_settings (key,value) values ('plan_prices','{"day":1,"sale":{"active":true,"week":1}}') on conflict (key) do update set value=excluded.value`);
    const r = await spost(FR(a), { planId: 'week' });
    assert.equal(r.status, 200, r.text); assert.equal(Number(r.json.license.price), 0);
    const c = await spost(FR(a), { planId: 'custom', customDays: 5 });
    assert.equal(c.status, 200, c.text); assert.equal(Number(c.json.license.price), 0);
  });
  after(() => {
    if (ORIGINAL_PRICING === null) sql(`delete from platform_settings where key='plan_prices'`);
    else sql(`insert into platform_settings (key, value) values ('plan_prices', ${q(ORIGINAL_PRICING)}::jsonb) on conflict (key) do update set value = excluded.value`);
  });
});

describe('9. Licences: mark-paid', () => {
  const MP = (t, id) => `${TP(t)}/licenses/${id}/mark-paid`;
  it('marks an invoice licence paid (paid_at set) and audits the confirmation', async () => {
    const t = mkTenant({ label: 'mp1' }); const l = mkLic(t, 0, { price: 250, paid: false, payment_method: 'invoice' });
    const r = await spost(MP(t, l), {});
    assert.equal(r.status, 200, r.text); assert.equal(r.json.license.paid, true); assert.ok(r.json.license.paid_at); assert.equal(r.json.activated, false);
    assert.equal(licRow(l).paid, true);
    assert.ok(audit(t.id).some((m) => /Payment confirmed for Week license \(£250(\.00)?\)/.test(m)), JSON.stringify(audit(t.id)));
  });
  it('a pending account goes active only when its LAST unpaid licence is marked paid', async () => {
    const t = mkTenant({ label: 'mp2', status: 'pending', services: 2 });
    const l1 = mkLic(t, 0, { price: 100, paid: false, payment_method: 'invoice' }); const l2 = mkLic(t, 1, { price: 100, paid: false, payment_method: 'invoice' });
    const r1 = await spost(MP(t, l1), {}); assert.equal(r1.json.activated, false); assert.equal(tenantRow(t.id).status, 'pending');
    const r2 = await spost(MP(t, l2), {}); assert.equal(r2.json.activated, true); assert.equal(tenantRow(t.id).status, 'active');
    assert.ok(audit(t.id).some((m) => /account activated/.test(m)));
  });
  it('refunded unpaid licences do not hold a pending account back', async () => {
    const t = mkTenant({ label: 'mp3', status: 'pending', services: 2 });
    mkLic(t, 1, { price: 100, paid: false, payment_method: 'invoice', status: 'refunded' });
    const l1 = mkLic(t, 0, { price: 100, paid: false, payment_method: 'invoice' });
    assert.equal((await spost(MP(t, l1), {})).json.activated, true);
  });
  it('a disabled account stays disabled when its licence is marked paid; an active one stays active', async () => {
    const t = mkTenant({ label: 'mp4', status: 'disabled' }); const l = mkLic(t, 0, { paid: false, payment_method: 'invoice' });
    const r = await spost(MP(t, l), {}); assert.equal(r.status, 200); assert.equal(r.json.activated, false);
    assert.equal(tenantRow(t.id).status, 'disabled');
  });
  it('pay-later licences cannot be marked paid (409)', async () => {
    const t = mkTenant({ label: 'mp5' }); const l = mkLic(t, 0, { paid: false, payment_method: 'later' });
    const r = await spost(MP(t, l), {}); assert.equal(r.status, 409); assert.equal(licRow(l).paid, false);
  });
  it('[S08] marking an already-paid licence again is a no-op: paid_at is not rewritten and no second "payment confirmed" entry appears', async () => {
    const t = mkTenant({ label: 'mp6' }); const l = mkLic(t, 0, { price: 80, paid: false, payment_method: 'invoice' });
    await spost(MP(t, l), {});
    const first = licRow(l).paid_at; const entries = audit(t.id).length;
    await new Promise((r) => setTimeout(r, 30));
    const again = await spost(MP(t, l), {});
    assert.ok(again.status === 200 || again.status === 409, `${again.status}`);
    assert.equal(licRow(l).paid_at, first, 'paid_at moved');
    assert.equal(audit(t.id).length, entries, 'duplicate audit entry for a payment that was already confirmed');
  });
  it('[S08] a refunded licence cannot be marked paid (409) - it would record a payment for money already returned', async () => {
    const t = mkTenant({ label: 'mp7' }); const l = mkLic(t, 0, { price: 90, paid: false, payment_method: 'invoice', status: 'refunded' });
    const r = await spost(MP(t, l), {});
    assert.equal(r.status, 409, `${r.status} ${r.text}`);
    assert.equal(licRow(l).paid, false);
  });
  it('wrong tenant, unknown and malformed licence ids -> 404 and nothing changes', async () => {
    const t = mkTenant({ label: 'mp8' }); const o = mkTenant({ label: 'mp9' }); const l = mkLic(o, 0, { paid: false, payment_method: 'invoice' });
    for (const p of [MP(t, l), `${SYS}/tenants/${UUID0}/licenses/${l}/mark-paid`, MP(t, UUID0), MP(t, 'bad')]) assert.equal((await spost(p, {})).status, 404, p);
    assert.equal(licRow(l).paid, false);
  });
});

describe('10. Licences: refund', () => {
  const RF = (t, svc, id) => `${TP(t)}/services/${svc}/licenses/${id}/refund`;
  it('available licence: refunded, timestamp set, audited, and no longer in the tenant\'s spend', async () => {
    const t = mkTenant({ label: 'rf1' }); const l = mkLic(t, 0, { price: 100 });
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 200, r.text); assert.equal(r.json.license.status, 'refunded'); assert.ok(r.json.license.refunded_at); assert.equal(r.json.license.service_name, 'Svc 1');
    assert.equal(licRow(l).status, 'refunded');
    assert.ok(audit(t.id).some((m) => /License refunded by platform admin for "Svc 1" — Week/.test(m)));
    const row = (await sget(`${SYS}/tenants`)).json.tenants.find((x) => x.id === t.id);
    assert.equal(Number(row.total_spend), 0);
  });
  it('double refund -> 409 and the refund timestamp is not rewritten', async () => {
    const t = mkTenant({ label: 'rf2' }); const l = mkLic(t, 0);
    await spost(RF(t, t.svcIds[0], l), {});
    const at = licRow(l).refunded_at; const n = audit(t.id).length;
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 409, r.text); assert.equal(licRow(l).refunded_at, at); assert.equal(audit(t.id).length, n);
  });
  it('support override: a licence bought long ago (beyond the 90-day customer window) can still be refunded', async () => {
    const t = mkTenant({ label: 'rf3' }); const l = mkLic(t, 0, { age: 400 });
    assert.equal((await spost(RF(t, t.svcIds[0], l), {})).status, 200);
  });
  it('scheduled (future) licence: refunded and the hours set for its window are cleared, other days untouched', async () => {
    const t = mkTenant({ label: 'rf4' });
    const s = addDays(T0, 10); const e = addDays(T0, 16);
    const l = mkLic(t, 0, { status: 'scheduled', start: s, end: e });
    mkDay(t, 0, addDays(T0, 11)); mkDay(t, 0, addDays(T0, 20));
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 200, r.text); assert.equal(r.json.license.status, 'refunded');
    const days = sqlJson(`select date::text d from service_daily_config where service_id='${t.svcIds[0]}'`).map((x) => x.d);
    assert.deepEqual(days, [addDays(T0, 20)]);
  });
  it('active licence (window includes today, hours set) cannot be refunded (409)', async () => {
    const t = mkTenant({ label: 'rf5' }); const l = mkLic(t, 0, { status: 'active', start: addDays(T0, -1), end: addDays(T0, 5) }); mkDay(t, 0, T0);
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 409, r.text); assert.equal(licRow(l).status, 'active');
  });
  it('a scheduled licence whose start date has arrived counts as live (status is resolved before the check) -> 409', async () => {
    const t = mkTenant({ label: 'rf6' }); const l = mkLic(t, 0, { status: 'scheduled', start: T0, end: addDays(T0, 6) }); mkDay(t, 0, T0);
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 409, r.text); assert.notEqual(licRow(l).status, 'refunded');
  });
  it('expired licence cannot be refunded (409), including one whose window passed but was still stored as active', async () => {
    const t = mkTenant({ label: 'rf7', services: 2 });
    const l1 = mkLic(t, 0, { status: 'expired', start: addDays(T0, -20), end: addDays(T0, -14) });
    const l2 = mkLic(t, 1, { status: 'active', start: addDays(T0, -20), end: addDays(T0, -14) });
    assert.equal((await spost(RF(t, t.svcIds[0], l1), {})).status, 409);
    assert.equal((await spost(RF(t, t.svcIds[1], l2), {})).status, 409);
    assert.equal(licRow(l2).status, 'expired');
  });
  it('a scheduled licence with no hours ever set reverts to available once its start date has arrived, then can be refunded', async () => {
    const t = mkTenant({ label: 'rf8' }); const l = mkLic(t, 0, { status: 'scheduled', start: T0, end: addDays(T0, 6) });
    const r = await spost(RF(t, t.svcIds[0], l), {});
    assert.equal(r.status, 200, r.text);
  });
  it('unpaid pay-later licences have nothing to refund (409); unpaid invoice licences can be cancelled by refund', async () => {
    const t = mkTenant({ label: 'rf9', services: 2 });
    const later = mkLic(t, 0, { paid: false, payment_method: 'later' }); const inv = mkLic(t, 1, { paid: false, payment_method: 'invoice' });
    assert.equal((await spost(RF(t, t.svcIds[0], later), {})).status, 409);
    assert.equal((await spost(RF(t, t.svcIds[1], inv), {})).status, 200);
  });
  it('wrong tenant / wrong service / unknown / malformed ids -> 404 and nothing changes', async () => {
    const t = mkTenant({ label: 'rf10', services: 2 }); const o = mkTenant({ label: 'rf11' });
    const l = mkLic(t, 0); const lo = mkLic(o, 0);
    const paths = [RF(t, t.svcIds[1], l), RF(t, o.svcIds[0], l), RF(o, t.svcIds[0], l), RF(t, t.svcIds[0], lo), RF(t, t.svcIds[0], UUID0), RF(t, UUID0, l), `${SYS}/tenants/${UUID0}/services/${t.svcIds[0]}/licenses/${l}/refund`, RF(t, t.svcIds[0], 'bad'), RF(t, 'bad', l)];
    for (const p of paths) { const r = await spost(p, {}); assert.equal(r.status, 404, `${p} -> ${r.status} ${r.text}`); }
    assert.equal(licRow(l).status, 'available'); assert.equal(licRow(lo).status, 'available');
  });
  it('refunds are excluded from reports and counted once: refunding moves overview revenue down by exactly the price', async (ctx) => {
    if (!(await sane(ctx))) return;
    const t = mkTenant({ label: 'rf12' }); const l = mkLic(t, 0, { price: 321, plan_id: 'month' });
    const b4 = (await sget(`${SYS}/reports/overview`)).json;
    await spost(RF(t, t.svcIds[0], l), {});
    const af = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(money(b4.totalRevenue - af.totalRevenue), 321);
    assert.equal(money((b4.revenueByPlan.month || 0) - (af.revenueByPlan.month || 0)), 321);
  });
});

// =====================================================================================
// 11. DELETE TENANT
// =====================================================================================
describe('11. Delete tenant', () => {
  it('cascades everything, keeps an anonymised revenue snapshot, and is 404 the second time', async () => {
    const t = mkTenant({ label: 'del1', locs: ['A', 'B'], services: 2, locationCount: 2 }); const st = mkStaff(t);
    mkLic(t, 0, { price: 100, plan_id: 'week' }); mkLic(t, 0, { price: 40, plan_id: 'day', paid: false, payment_method: 'invoice' }); mkLic(t, 1, { price: 600, plan_id: 'year', status: 'refunded' });
    mkDay(t, 0, addDays(T0, 1));
    sql(`insert into audit_log (tenant_id,message) values ('${t.id}','something')`);
    sql(`insert into admin_otp (tenant_id,code,expires_at) values ('${t.id}','AAAAAA', now() + interval '1 hour')`);
    const adminTok = await adminLogin(t); const staffTok = await staffLogin(st.email);
    const before = (await sget(`${SYS}/reports/overview`)).json;

    const r = await sdel(TP(t));
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    for (const table of ['locations', 'services', 'service_licenses', 'staff_members', 'audit_log', 'admin_otp', 'location_codes', 'staff_otp']) assert.equal(count(table, t.id), 0, table);
    assert.equal(Number(sql(`select count(*) from tenants where id='${t.id}'`)), 0);
    assert.equal(Number(sql(`select count(*) from service_daily_config where service_id in ('${t.svcIds.join("','")}')`)), 0);

    const snaps = sqlJson(`select * from deleted_tenant_revenue where original_tenant_id='${t.id}'`);
    assert.equal(snaps.length, 1);
    const s = snaps[0];
    assert.equal(Number(s.total_revenue), 140); assert.equal(Number(s.pending_revenue), 0); assert.equal(s.license_count, 2); assert.equal(s.location_count, 2);
    assert.deepEqual(s.revenue_by_plan, { week: 100, day: 40 });
    assert.equal(s.business_name, t.name);
    assert.ok(!JSON.stringify(s).includes(t.email), 'no email in the snapshot');

    const after = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(after.customerCount, before.customerCount - 1);
    assert.equal(after.deletedCustomerCount, before.deletedCustomerCount + 1);
    assert.equal(money(after.totalRevenue), money(before.totalRevenue), 'revenue must not drop when an account is deleted');
    assert.equal(money(after.deletedRevenue - before.deletedRevenue), 140);
    assert.equal(after.totalLocations, before.totalLocations - 2);

    assert.equal((await sdel(TP(t))).status, 404);
    assert.equal(sqlJson(`select 1 from deleted_tenant_revenue where original_tenant_id='${t.id}'`).length, 1, 'a repeat delete must not add a second snapshot');
    assert.equal((await get('/api/tenant/me', { token: adminTok })).status, 404);
    assert.ok([401, 404].includes((await get('/api/tenant/me', { token: staffTok })).status));
    assert.equal((await get(`/api/public/tenant/${t.id}/info`)).status, 404);
    assert.equal((await get(`/api/public/code/${t.locCodes[0]}`)).status, 404);
    assert.equal((await sget(`${TP(t)}/detail`)).status, 404);
    assert.equal((await spatch(TP(t), { status: 'active' })).status, 404);
  });
  it('[S09] deleting an unconfirmed (pending) account keeps pending revenue pending: totals, pending and the by-plan split are all unchanged', async () => {
    const t = mkTenant({ label: 'del2', status: 'pending' });
    mkLic(t, 0, { price: 200, plan_id: 'month', paid: false, payment_method: 'invoice' });
    const b4 = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal((await sdel(TP(t))).status, 200);
    const af = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(money(af.totalRevenue - b4.totalRevenue), 0, 'total revenue');
    assert.equal(money(af.pendingRevenue - b4.pendingRevenue), 0, 'pending revenue');
    assert.equal(money((af.revenueByPlan.month || 0) - (b4.revenueByPlan.month || 0)), 0, 'unconfirmed invoice amount leaked into the by-plan revenue split');
    const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
    assert.equal(money(sum(af.revenueByPlan) - sum(b4.revenueByPlan)), 0);
  });
  it('[S10] two simultaneous deletes of one tenant: exactly one succeeds and only one snapshot is recorded', async () => {
    const t = mkTenant({ label: 'del3' }); mkLic(t, 0, { price: 77, plan_id: 'week' });
    // many licences make the snapshot step slow enough for concurrent requests to overlap
    sql(`insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status) select '${t.id}','${t.svcIds[0]}','day','Day',1,1,'available' from generate_series(1,20000)`);
    const tok = await S();
    const rs = await Promise.all(Array.from({ length: 8 }, () => del(TP(t), { token: tok })));
    const codes = rs.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 404, 404, 404, 404, 404, 404, 404], JSON.stringify(rs.map((r) => r.text)));
    assert.equal(sqlJson(`select 1 from deleted_tenant_revenue where original_tenant_id='${t.id}'`).length, 1, 'revenue double-counted');
  });
  it('unknown / malformed tenant id -> 404 and no snapshot is written', async () => {
    const n = Number(sql(`select count(*) from deleted_tenant_revenue`));
    assert.equal((await sdel(`${SYS}/tenants/${UUID0}`)).status, 404);
    assert.equal((await sdel(`${SYS}/tenants/nope`)).status, 404);
    assert.equal(Number(sql(`select count(*) from deleted_tenant_revenue`)), n);
  });
});

// =====================================================================================
// 12. PRICING
// =====================================================================================
describe('12. Pricing', () => {
  const FULL = { day: 25, week: 100, month: 200, year: 600, customDailyRate: 20, sale: { active: false } };
  const resetPricing = () => sql(`delete from platform_settings where key='plan_prices'`);
  before(resetPricing);
  after(() => {
    if (ORIGINAL_PRICING === null) resetPricing();
    else sql(`insert into platform_settings (key, value) values ('plan_prices', ${q(ORIGINAL_PRICING)}::jsonb) on conflict (key) do update set value = excluded.value`);
  });
  it('with nothing saved, the admin GET and the public GET agree on the defaults', async () => {
    resetPricing();
    const adm = (await sget(`${SYS}/pricing`)).json.pricing; const pub = (await get('/api/public/pricing')).json.pricing;
    assert.equal(pub.week, 100);
    assert.deepEqual(adm, pub, `[S11] admin sees ${JSON.stringify(adm)} while customers are charged ${JSON.stringify(pub)}`);
  });
  it('PUT stores exactly what the form sends and the public endpoint (no auth) reflects it immediately', async () => {
    const body = { day: 30, week: 120.5, month: 250, year: 700, customDailyRate: 22.75, sale: { active: true, day: 20, week: null, month: 199.99, year: null } };
    const r = await sput(`${SYS}/pricing`, body);
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.pricing, body);
    assert.deepEqual((await sget(`${SYS}/pricing`)).json.pricing, body);
    const pub = await get('/api/public/pricing');
    assert.equal(pub.status, 200); assert.deepEqual(pub.json.pricing, body);
    assert.equal(pub.headers.get('access-control-allow-origin'), '*');
  });
  it('whole-number and zero prices are accepted; the boundaries 0 and 1,000,000 are valid', async () => {
    const r = await sput(`${SYS}/pricing`, { ...FULL, day: 0, year: 1000000 });
    assert.equal(r.status, 200, r.text);
  });
  it('rejects negative, non-finite, non-numeric, oversized and wrongly-typed prices with 400 and leaves the stored table alone', async () => {
    await sput(`${SYS}/pricing`, FULL);
    const stored = sql(`select value::text from platform_settings where key='plan_prices'`);
    const bad = [-1, -0.01, 1000001, '50', '', 'abc', 'NaN', true, false, [10], { a: 1 }];
    const cases = [];
    for (const k of ['day', 'week', 'month', 'year', 'customDailyRate']) for (const v of bad) cases.push({ ...FULL, [k]: v });
    for (const k of ['day', 'week', 'month', 'year']) for (const v of [-1, '5', true, [1], 1000001]) cases.push({ ...FULL, sale: { active: true, [k]: v } });
    await forAll(cases, async (body) => {
      const r = await sput(`${SYS}/pricing`, body);
      if (r.status !== 400) return `${r.status} ${r.text.slice(0, 80)}`;
      return null;
    });
    assert.equal(sql(`select value::text from platform_settings where key='plan_prices'`), stored);
  });
  it('rejects non-finite numbers that JSON can carry as 1e999 (Infinity) and keeps the stored table', async () => {
    await sput(`${SYS}/pricing`, FULL);
    const stored = sql(`select value::text from platform_settings where key='plan_prices'`);
    for (const raw of ['{"day":1e999}', '{"week":-1e999}', '{"customDailyRate":1e999}', '{"sale":{"active":true,"day":1e999}}']) {
      const r = await api('PUT', `${SYS}/pricing`, { token: await S(), rawBody: raw });
      assert.equal(r.status, 400, `${raw} -> ${r.status} ${r.text}`);
    }
    assert.equal(sql(`select value::text from platform_settings where key='plan_prices'`), stored);
  });
  it('rejects a malformed sale block: non-object, array, non-boolean active', async () => {
    await forAll([{ ...FULL, sale: 5 }, { ...FULL, sale: 'on' }, { ...FULL, sale: [] }, { ...FULL, sale: [{ active: true }] }, { ...FULL, sale: { active: 'true' } }, { ...FULL, sale: { active: 1 } }, { ...FULL, sale: true }],
      async (body) => { const r = await sput(`${SYS}/pricing`, body); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 80)}`; });
  });
  it('[S11] a partial update never wipes the other prices: {} and {day} keep the rest, so customers can always be charged', async () => {
    await sput(`${SYS}/pricing`, FULL);
    const r0 = await sput(`${SYS}/pricing`, {});
    assert.equal(r0.status, 200, r0.text);
    const pub0 = (await get('/api/public/pricing')).json.pricing;
    for (const k of ['day', 'week', 'month', 'year', 'customDailyRate']) assert.equal(typeof pub0[k], 'number', `public ${k} is ${JSON.stringify(pub0[k])} after PUT {}`);
    const r1 = await sput(`${SYS}/pricing`, { day: 31 });
    assert.equal(r1.status, 200, r1.text);
    const pub = (await get('/api/public/pricing')).json.pricing;
    assert.equal(pub.day, 31);
    for (const k of ['week', 'month', 'year', 'customDailyRate']) assert.equal(pub[k], FULL[k], `${k} lost`);
  });
  it('[S11] null for a regular price is rejected (it would be stored as "no price")', async () => {
    await sput(`${SYS}/pricing`, FULL);
    for (const k of ['day', 'week', 'month', 'year', 'customDailyRate']) {
      const r = await sput(`${SYS}/pricing`, { ...FULL, [k]: null });
      assert.equal(r.status, 400, `${k}: ${r.status} ${r.text}`);
    }
    assert.equal((await get('/api/public/pricing')).json.pricing.week, 100);
  });
  it('[S12] a price with more than 2 decimals, or a sale price higher than the regular price, is rejected', async () => {
    await sput(`${SYS}/pricing`, FULL);
    assert.equal((await sput(`${SYS}/pricing`, { ...FULL, day: 19.999 })).status, 400, 'sub-penny regular price');
    assert.equal((await sput(`${SYS}/pricing`, { ...FULL, sale: { active: true, week: 100.001 } })).status, 400, 'sub-penny sale price');
    assert.equal((await sput(`${SYS}/pricing`, { ...FULL, sale: { active: true, week: 150 } })).status, 400, 'a "sale" that costs more than normal');
    assert.equal((await sput(`${SYS}/pricing`, { ...FULL, sale: { active: false, week: 100 } })).status, 200, 'equal is fine');
  });
  it('[S14] lowering a regular price below its saved sale price is rejected (customers must never be charged above list)', async () => {
    await sput(`${SYS}/pricing`, { ...FULL, sale: { active: true, week: 90 } });
    const r = await sput(`${SYS}/pricing`, { week: 80 });
    assert.equal(r.status, 400, r.text);
    assert.equal((await get('/api/public/pricing')).json.pricing.week, 100, 'rejected change must not be saved');
    assert.equal((await sput(`${SYS}/pricing`, { week: 80, sale: { active: true, week: 70 } })).status, 200, 'lowering both together is fine');
    await sput(`${SYS}/pricing`, FULL);
  });
  it('hostile bodies never 500: non-object JSON, arrays, strings, prototype keys', async () => {
    for (const raw of ['"x"', '5', 'null', '[1]', '{"__proto__":{"day":1}}', '{"constructor":{"prototype":{"x":1}}}', '{"sale":{"__proto__":{"active":true}}}']) {
      const r = await api('PUT', `${SYS}/pricing`, { token: await S(), rawBody: raw });
      assert.ok(r.status < 500, `${raw} -> ${r.status} ${r.text}`);
    }
    assert.equal(({}).day, undefined, 'Object.prototype polluted');
  });
  it('sale pricing is what a customer is actually charged; custom plans ignore it; switching it off restores list prices', async () => {
    const t = mkTenant({ label: 'price-buy' }); const tok = await adminLogin(t);
    await sput(`${SYS}/pricing`, { ...FULL, sale: { active: true, week: 80, month: null } });
    const buy = (planId, extra = {}) => post(`/api/tenant/services/${t.svcIds[0]}/licenses`, { planId, paymentMethod: 'card', ...extra }, { token: tok });
    const w = await buy('week'); assert.equal(w.status, 200, w.text); assert.equal(Number(w.json.license.price), 80);
    const m = await buy('month'); assert.equal(Number(m.json.license.price), 200, 'plan without a sale price stays at list');
    const c = await buy('custom', { customDays: 10 }); assert.equal(Number(c.json.license.price), 200, 'custom = 10 days x 20');
    await sput(`${SYS}/pricing`, { ...FULL, sale: { active: false, week: 80 } });
    const w2 = await buy('week'); assert.equal(Number(w2.json.license.price), 100);
    const pub = (await get('/api/public/pricing')).json.pricing; assert.equal(pub.sale.active, false);
  });
  it('a price change only affects licences bought afterwards', async () => {
    const t = mkTenant({ label: 'price-old' }); const tok = await adminLogin(t);
    await sput(`${SYS}/pricing`, FULL);
    const l = await post(`/api/tenant/services/${t.svcIds[0]}/licenses`, { planId: 'day', paymentMethod: 'card' }, { token: tok });
    await sput(`${SYS}/pricing`, { ...FULL, day: 99 });
    assert.equal(Number(licRow(l.json.license.id).price), 25);
  });
  it('the console endpoint needs a system token; the public one is read-only', async () => {
    assert.equal((await get(`${SYS}/pricing`)).status, 401);
    assert.equal((await put('/api/public/pricing', FULL)).status, 404);
    assert.equal((await post('/api/public/pricing', FULL)).status, 404);
  });
});

// =====================================================================================
// 13. REPORTS OVERVIEW
// =====================================================================================
describe('13. Reports overview', () => {
  it('shape: numbers, not strings / NaN / null', async () => {
    const r = await sget(`${SYS}/reports/overview`); assert.equal(r.status, 200);
    for (const k of ['customerCount', 'totalRevenue', 'pendingRevenue', 'totalLocations', 'deletedCustomerCount', 'deletedRevenue']) assert.ok(Number.isFinite(r.json[k]), `${k}=${r.json[k]}`);
    for (const [plan, v] of Object.entries(r.json.revenueByPlan)) assert.ok(Number.isFinite(v), `${plan}=${v}`);
  });
  it('customer / location / revenue figures reconcile with the database', async (ctx) => {
    if (!(await sane(ctx))) return;
    const r = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(r.customerCount, Number(sql(`select count(*) from tenants`)));
    assert.equal(r.totalLocations, Number(sql(`select coalesce(sum(location_count),0) from tenants`)));
    assert.equal(r.deletedCustomerCount, Number(sql(`select count(*) from deleted_tenant_revenue`)));
    const live = Number(sql(`select coalesce(sum(l.price),0) from service_licenses l join tenants t on t.id=l.tenant_id where l.status<>'refunded' and t.status<>'pending'`));
    const livePending = Number(sql(`select coalesce(sum(l.price),0) from service_licenses l join tenants t on t.id=l.tenant_id where l.status<>'refunded' and t.status='pending'`));
    const delTotal = Number(sql(`select coalesce(sum(total_revenue),0) from deleted_tenant_revenue`));
    const delPending = Number(sql(`select coalesce(sum(pending_revenue),0) from deleted_tenant_revenue`));
    assert.equal(money(r.totalRevenue), money(live + delTotal));
    assert.equal(money(r.pendingRevenue), money(livePending + delPending));
    assert.equal(money(r.deletedRevenue), money(delTotal));
  });
  it('known fixtures move every figure by exactly the expected amount (active / pending / disabled tenants, refunded + free licences, per-plan split)', async (ctx) => {
    if (!(await sane(ctx))) return;
    const b4 = (await sget(`${SYS}/reports/overview`)).json;
    const act = mkTenant({ label: 'rep-act', locs: ['a', 'b'], services: 2 });
    mkLic(act, 0, { price: 100, plan_id: 'week' }); mkLic(act, 1, { price: 25, plan_id: 'day' }); mkLic(act, 1, { price: 0, plan_id: 'week' }); mkLic(act, 0, { price: 600, plan_id: 'year', status: 'refunded' });
    const pen = mkTenant({ label: 'rep-pen', status: 'pending' }); mkLic(pen, 0, { price: 200, plan_id: 'month', paid: false, payment_method: 'invoice' });
    const dis = mkTenant({ label: 'rep-dis', status: 'disabled', locs: ['x', 'y', 'z'], services: 1 }); mkLic(dis, 0, { price: 50, plan_id: 'day' });
    const af = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(af.customerCount - b4.customerCount, 3);
    assert.equal(af.totalLocations - b4.totalLocations, 2 + 1 + 3);
    assert.equal(money(af.totalRevenue - b4.totalRevenue), 175, 'active 125 + disabled 50 (pending and refunded excluded)');
    assert.equal(money(af.pendingRevenue - b4.pendingRevenue), 200);
    assert.equal(money((af.revenueByPlan.week || 0) - (b4.revenueByPlan.week || 0)), 100);
    assert.equal(money((af.revenueByPlan.day || 0) - (b4.revenueByPlan.day || 0)), 75);
    assert.equal(money((af.revenueByPlan.month || 0) - (b4.revenueByPlan.month || 0)), 0, 'pending invoice is not revenue');
    assert.equal(money((af.revenueByPlan.year || 0) - (b4.revenueByPlan.year || 0)), 0, 'refunded is not revenue');
    assert.equal(af.deletedCustomerCount, b4.deletedCustomerCount);
  });
  it('status changes move money between pending and confirmed exactly once', async (ctx) => {
    if (!(await sane(ctx))) return;
    const t = mkTenant({ label: 'rep-flip', status: 'pending' }); mkLic(t, 0, { price: 300, plan_id: 'year', paid: false, payment_method: 'invoice' });
    const p = (await sget(`${SYS}/reports/overview`)).json;
    await spatch(TP(t), { status: 'active' });
    const a2 = (await sget(`${SYS}/reports/overview`)).json;
    assert.equal(money(a2.totalRevenue - p.totalRevenue), 300); assert.equal(money(p.pendingRevenue - a2.pendingRevenue), 300);
    assert.equal(money(a2.revenueByPlan.year - (p.revenueByPlan.year || 0)), 300);
  });
  it('[S13] revenue figures are exact to the penny (no floating-point noise such as 0.30000000000000004)', async (ctx) => {
    if (!(await sane(ctx))) return;
    const t = mkTenant({ label: 'rep-float', services: 3 });
    mkLic(t, 0, { price: 0.1, plan_id: 'day' }); mkLic(t, 1, { price: 0.2, plan_id: 'day' }); mkLic(t, 2, { price: 0.7, plan_id: 'day' });
    const r = (await sget(`${SYS}/reports/overview`)).json;
    const twoDp = (n) => /^-?\d+(\.\d{1,2})?$/.test(String(n));
    assert.ok(twoDp(r.totalRevenue), `totalRevenue=${r.totalRevenue}`); assert.ok(twoDp(r.pendingRevenue), `pendingRevenue=${r.pendingRevenue}`);
    assert.ok(twoDp(r.deletedRevenue), `deletedRevenue=${r.deletedRevenue}`);
    for (const [k, v] of Object.entries(r.revenueByPlan)) assert.ok(twoDp(v), `${k}=${v}`);
  });
  it('an empty-licence tenant (price null) does not turn totals into NaN', async () => {
    const t = mkTenant({ label: 'rep-null' });
    sql(`insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status) values ('${t.id}','${t.svcIds[0]}','week','Week',7,null,'available')`);
    const r = (await sget(`${SYS}/reports/overview`)).json;
    assert.ok(Number.isFinite(r.totalRevenue));
  });
});

// =====================================================================================
// 14. SIMULATED CLOCK
// =====================================================================================
describe('14. Simulated clock', () => {
  after(async () => {
    if (ORIGINAL_CLOCK.simulated) await spost(`${SYS}/clock`, { date: ORIGINAL_CLOCK.today }); else await sdel(`${SYS}/clock`);
  });
  it('GET: { today, simulated }, today is a plain YYYY-MM-DD; public clock agrees', async () => {
    const r = await sget(`${SYS}/clock`); assert.equal(r.status, 200);
    assert.match(r.json.today, /^\d{4}-\d{2}-\d{2}$/); assert.equal(typeof r.json.simulated, 'boolean');
    assert.deepEqual((await get('/api/public/clock')).json, r.json);
  });
  it('POST sets it (visible on both endpoints), DELETE restores the real date', async () => {
    const r = await spost(`${SYS}/clock`, { date: '2031-03-04' });
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json, { today: '2031-03-04', simulated: true });
    assert.deepEqual((await get('/api/public/clock')).json, { today: '2031-03-04', simulated: true });
    const d = await sdel(`${SYS}/clock`);
    assert.equal(d.status, 200); assert.equal(d.json.simulated, false);
    assert.equal(d.json.today, new Date().toISOString().slice(0, 10));
    assert.equal((await sdel(`${SYS}/clock`)).status, 200, 'DELETE is idempotent');
  });
  it('strict dates: anything that is not a real YYYY-MM-DD in 2000..2100 is a 400 and does not change the clock', async () => {
    await spost(`${SYS}/clock`, { date: '2030-05-05' });
    await forAll([{}, { date: '' }, { date: null }, { date: 20300505 }, { date: true }, { date: [] }, { date: ['2030-05-05'] }, { date: { d: 1 } }, { date: '2030-5-5' }, { date: '05/05/2030' }, { date: '2030-02-30' }, { date: '2030-13-01' }, { date: '2030-00-10' }, { date: '2030-04-31' }, { date: '2029-02-29' },
      { date: '1999-12-31' }, { date: '2101-01-01' }, { date: '0000-00-00' }, { date: '2030-05-05T00:00:00Z' }, { date: ' 2030-05-05' }, { date: '2030-05-05\n' }, { date: 'tomorrow' }, { date: 'x'.repeat(10000) }, { date: '２０３０-05-05' }],
      async (b) => { const r = await spost(`${SYS}/clock`, b); return r.status === 400 ? null : `${r.status} ${r.text.slice(0, 60)}`; });
    assert.equal((await sget(`${SYS}/clock`)).json.today, '2030-05-05', 'a rejected request must not move the clock');
    assert.equal((await spost(`${SYS}/clock`, { date: '2028-02-29' })).status, 200, 'real leap day');
    assert.equal((await spost(`${SYS}/clock`, { date: '2000-01-01' })).status, 200);
    assert.equal((await spost(`${SYS}/clock`, { date: '2100-12-31' })).status, 200);
  });
  it('moving the clock expires licences and closes availability exactly as a real day would (and restoring brings the state back)', async () => {
    await sdel(`${SYS}/clock`);
    const t = mkTenant({ label: 'clock' }); const real = (await sget(`${SYS}/clock`)).json.today;
    mkLic(t, 0, { status: 'active', start: real, end: addDays(real, 1) }); mkDay(t, 0, real, [0, 30, 60, 540, 570]);
    const avail = async (d) => (await get(`/api/public/tenant/${t.id}/services/${t.svcIds[0]}/availability?date=${d}&clockMinutes=0`)).json;
    const lic = async () => (await sget(`${TP(t)}/detail`)).json.licenses[0].status;
    assert.equal((await avail(real)).open, true);
    assert.equal(await lic(), 'active');
    await spost(`${SYS}/clock`, { date: addDays(real, 5) });
    assert.equal((await avail(addDays(real, 5))).open, false);
    assert.equal((await avail(addDays(real, 5))).reason, 'outside_license_window');
    assert.equal(await lic(), 'expired');
    assert.equal((await get(`/api/public/tenant/${t.id}/services`)).json.services.length, 0, 'no live licence -> no service offered');
    await sdel(`${SYS}/clock`);
  });
  it('a future clock turns a scheduled licence active; the in-between day boundaries are inclusive', async () => {
    await sdel(`${SYS}/clock`);
    const t = mkTenant({ label: 'clock2' }); const real = (await sget(`${SYS}/clock`)).json.today;
    const s = addDays(real, 10);
    mkLic(t, 0, { status: 'scheduled', start: s, end: addDays(s, 2) }); mkDay(t, 0, s);
    const status = async () => (await sget(`${TP(t)}/detail`)).json.licenses[0].status;
    assert.equal(await status(), 'scheduled');
    await spost(`${SYS}/clock`, { date: addDays(s, -1) }); assert.equal(await status(), 'scheduled');
    await spost(`${SYS}/clock`, { date: s }); assert.equal(await status(), 'active');
    await spost(`${SYS}/clock`, { date: addDays(s, 2) }); assert.equal(await status(), 'active');
    await spost(`${SYS}/clock`, { date: addDays(s, 3) }); assert.equal(await status(), 'expired');
    await sdel(`${SYS}/clock`);
  });
  it('only a system token can change the clock', async () => {
    assert.equal((await post(`${SYS}/clock`, { date: '2030-01-01' })).status, 401);
    assert.equal((await del(`${SYS}/clock`)).status, 401);
    assert.equal((await get('/api/public/clock')).json.simulated, false);
  });
});

// =====================================================================================
// 15. ROBUSTNESS: hostile input never 5xx; headers; server log
// =====================================================================================
describe('15. Robustness', () => {
  let t, st, lic;
  before(() => { t = mkTenant({ label: 'hostile' }); st = mkStaff(t); lic = mkLic(t, 0, { paid: false, payment_method: 'invoice' }); });
  const HOSTILE = [null, 0, -1, 1.5, 1e999, true, false, '', ' ', 'x'.repeat(20000), '\u0000', 'a\u0000b', '💥'.repeat(50), "'; drop table tenants;--", '<script>alert(1)</script>', [], [1, 2], {}, { a: { b: 1 } }, '__proto__', ['__proto__'], 99999999999999999999];
  it('typed-value sweep: every body field on every mutating system route x hostile values -> never a 5xx', async () => {
    const targets = [
      ['PATCH', TP(t), ['businessName', 'firstName', 'lastName', 'email', 'companyAddress', 'locationCount', 'status']],
      ['PATCH', `${TP(t)}/staff/${st.id}`, ['firstName', 'lastName', 'email']],
      ['PATCH', `${TP(t)}/locations/${t.locIds[0]}`, ['name', 'address']],
      ['PATCH', `${TP(t)}/services/${t.svcIds[0]}`, ['name', 'mode', 'slotMinutes', 'archived']],
      ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/annual`, ['price']],
      ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/free`, ['planId', 'customDays']],
      ['PUT', `${SYS}/pricing`, ['day', 'week', 'month', 'year', 'customDailyRate', 'sale']],
      ['POST', `${SYS}/clock`, ['date']],
    ];
    const bad = [];
    const tok = await S();
    for (const [m, p, fields] of targets) {
      for (const f of fields) for (const v of HOSTILE) {
        const body = f === 'planId' ? { planId: v, customDays: 5 } : { [f]: v };
        let r; try { r = await api(m, p, { token: tok, body }); } catch (e) { bad.push(`${m} ${p.split('/').slice(-2).join('/')} ${f}=${JSON.stringify(v)?.slice(0, 20)} threw ${e.message}`); continue; }
        if (r.status >= 500 || !r.json) bad.push(`${m} ${p.split('/').slice(-2).join('/')} ${f}=${JSON.stringify(v)?.slice(0, 20)} -> ${r.status} ${r.text.slice(0, 60)}`);
      }
    }
    // restore the things the sweep may have changed
    sql(`delete from platform_settings where key='plan_prices'`);
    await sdel(`${SYS}/clock`);
    assert.equal(bad.length, 0, `\n  ${bad.slice(0, 30).join('\n  ')}`);
  });
  it('the fixture survived the sweep: the sweep is only allowed to fail with 4xx', () => {
    assert.equal(Number(sql(`select count(*) from tenants where id='${t.id}'`)), 1);
  });
  it('malformed JSON, oversized, array and non-object bodies -> 4xx JSON on mutating routes', async () => {
    const tok = await S();
    const routes = [['PATCH', TP(t)], ['PUT', `${SYS}/pricing`], ['POST', `${SYS}/clock`], ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/annual`], ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/free`], ['PATCH', `${TP(t)}/staff/${st.id}`]];
    for (const [m, p] of routes) {
      for (const raw of ['{"a":', '[1,2]', '"str"', '{"a":"' + 'x'.repeat(300000) + '"}', '\u0000', '{"a":1}garbage']) {
        const r = await api(m, p, { token: tok, rawBody: raw });
        assert.ok(r.status < 500, `${m} ${p.slice(-30)} ${raw.slice(0, 15)} -> ${r.status}`);
        if (raw.length > 100000) assert.equal(r.status, 413);
      }
    }
  });
  it('no-body / urlencoded POSTs behave like an empty object (4xx for required fields, never 500)', async () => {
    const tok = await S();
    for (const [m, p] of [['POST', `${SYS}/clock`], ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/annual`], ['POST', `${TP(t)}/services/${t.svcIds[0]}/licenses/free`], ['POST', `${TP(t)}/licenses/${lic}/mark-paid`], ['PUT', `${SYS}/pricing`]]) {
      const a = await api(m, p, { token: tok }); assert.ok(a.status < 500, `${m} ${p} -> ${a.status}`);
      const b = await api(m, p, { token: tok, rawBody: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); assert.ok(b.status < 500, `${m} ${p} form -> ${b.status}`);
    }
    sql(`delete from platform_settings where key='plan_prices'`);
  });
  it('malformed path ids on every parametrised route -> 404 (never 500), including very long and encoded ones', async () => {
    const tok = await S();
    const ids = ['nope', '1', 'x'.repeat(2000), '%2e%2e', '..%2f..%2f', '%00', "'", UUID0.replace(/0/g, 'g')];
    const tpl = [
      ['GET', '/tenants/:a/detail'], ['PATCH', '/tenants/:a'], ['DELETE', '/tenants/:a'],
      ['PATCH', '/tenants/:a/staff/:b'], ['DELETE', '/tenants/:a/staff/:b'], ['PATCH', '/tenants/:a/locations/:b'], ['DELETE', '/tenants/:a/locations/:b'],
      ['PATCH', '/tenants/:a/services/:b'], ['DELETE', '/tenants/:a/services/:b'], ['POST', '/tenants/:a/licenses/:b/mark-paid'],
      ['POST', '/tenants/:a/services/:b/licenses/annual'], ['POST', '/tenants/:a/services/:b/licenses/free'], ['POST', '/tenants/:a/services/:b/licenses/:c/refund'],
    ];
    for (const [m, path] of tpl) for (const id of ids) {
      const e = encodeURIComponent(id);
      const url = SYS + path.replace(':a', e).replace(':b', t.id).replace(':c', t.id);
      const url2 = SYS + path.replace(':a', t.id).replace(':b', e).replace(':c', e);
      for (const u of (path.includes(':b') ? [url, url2] : [url])) { const r = await api(m, u, { token: tok, body: m === 'GET' || m === 'DELETE' ? undefined : {} }); assert.ok(r.status === 404, `${m} ${u.slice(0, 90)} -> ${r.status}`); }
    }
    assert.equal(Number(sql(`select count(*) from tenants where id='${t.id}'`)), 1);
  });
  it('responses and errors carry no framework banner, stack traces, SQL or file paths', async () => {
    const tok = await S();
    const LEAK = /(\bat\s+\S+\s+\(|node_modules|\/home\/|\.js:\d+|select\s.+\sfrom|syntax error|pg_|violates|ECONN|SequelizeError|stack)/i;
    for (const [m, p, body] of [['PATCH', TP(t), { locationCount: 'x' }], ['PATCH', TP(t), { email: `${'a'.repeat(300)}@x.com` }], ['GET', `${SYS}/tenants/bad/detail`], ['POST', `${SYS}/clock`, { date: 'zzz' }], ['PUT', `${SYS}/pricing`, { day: -1 }], ['POST', `${SYS}/clock`, undefined]]) {
      const r = await api(m, p, { token: tok, body });
      assert.equal(r.headers.get('x-powered-by'), null);
      assert.ok(!LEAK.test(r.text), `${m} ${p}: ${r.text.slice(0, 200)}`); assert.ok(r.text.length < 400);
      assert.ok(r.json, 'JSON error body');
    }
    const ok = await api('POST', '/api/auth/system/login', { body: { password: 'wrong' } });
    assert.equal(ok.headers.get('x-powered-by'), null);
  });
  it('[S02] authenticated system responses and the login response must not be cached or sniffed', async () => {
    const tok = await S();
    for (const r of [await get(`${SYS}/tenants`, { token: tok }), await get(`${SYS}/reports/overview`, { token: tok }), await post('/api/auth/system/login', { password: SYSTEM_PASSWORD })]) {
      assert.match(r.headers.get('cache-control') || '', /no-store/, `Cache-Control: ${r.headers.get('cache-control')}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
  });
  it('CORS: the console API only answers its configured origins; evil origins get no allow-origin header, including on preflight', async () => {
    const evil = { origin: 'https://evil.example' };
    for (const p of [`${SYS}/tenants`, `${SYS}/pricing`, '/api/auth/system/login']) {
      const r = await api('GET', p, { token: await S(), headers: evil }); assert.equal(r.headers.get('access-control-allow-origin'), null, p);
      const o = await api('OPTIONS', p, { headers: { ...evil, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization' } });
      assert.equal(o.headers.get('access-control-allow-origin'), null, `preflight ${p}`);
    }
    const ok = await api('OPTIONS', `${SYS}/pricing`, { headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });
  it('the shared state used by this suite is back to normal: clock not simulated (unless it was), pricing row restored', async () => {
    await sdel(`${SYS}/clock`);
    const c = (await get('/api/public/clock')).json;
    if (!ORIGINAL_CLOCK.simulated) assert.equal(c.simulated, false);
  });
});
