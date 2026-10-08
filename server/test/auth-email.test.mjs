// Real sign-in, account hardening: email providers, OTP storage, enumeration, sessions, WhatsApp webhook.
//   node --test server/test/auth-email.test.mjs        (needs the throwaway Postgres; starts its own API instances, no shared API required)
//
// Instances started here (each its own process on a free port, all against the local test DB):
//   prod    NODE_ENV=production, EMAIL_PROVIDER=resend pointed at a STUB Resend server in this process (captures every send),
//           WhatsApp webhook secret/verify token set, WhatsApp provider meta-cloud pointed at the same stub.
//   closed  NODE_ENV=production with no email configured: sign-in must fail closed (503) and say so loudly in its log.
//   demo    NODE_ENV=production + DEMO_MODE=true (log provider): the only production-like setup that may return codes.
//   dev     NODE_ENV=test, short session lifetimes (ADMIN/STAFF_SESSION_HOURS) to watch the sliding refresh.
// Real delivery by Resend / Meta is NOT exercised (no network): the stub verifies the request each provider would send.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(SERVER_DIR, '..');
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const JWT_SECRET = 'auth-email-test-secret-' + 'y'.repeat(24);
const OTP_PEPPER = 'auth-email-test-pepper-' + 'z'.repeat(16);
const RESEND_KEY = 're_test_SECRETKEY_' + crypto.randomBytes(6).toString('hex');
const WA_TOKEN = 'wa_test_TOKEN_' + crypto.randomBytes(6).toString('hex');
const WA_APP_SECRET = 'wa-app-secret-' + crypto.randomBytes(8).toString('hex');
const WA_VERIFY = 'wa-verify-' + crypto.randomBytes(6).toString('hex');
const WA_PHONE_ID = '1555000' + crypto.randomInt(1000, 9999);
const SYSTEM_PASSWORD = 'adminpass';
const PG = {
  host: process.env.PGHOST || '/tmp/pgtest', port: process.env.PGPORT || '5433',
  db: process.env.PGDATABASE || 'qb_test', user: process.env.PGUSER || 'postgres',
};
const DATABASE_URL = process.env.DATABASE_URL || `postgresql://${PG.user}@localhost:${PG.port}/${PG.db}`;
const RUN = crypto.randomBytes(3).toString('hex');
const rnd = () => crypto.randomBytes(4).toString('hex');
const randIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sql(query) {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ------------------------------------------------------------------ stub provider (Resend + Meta Cloud API)
const stub = { requests: [], mode: 'ok', server: null, port: 0 };
function stubStart() {
  return new Promise((resolve) => {
    stub.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const rec = { method: req.method, url: req.url, headers: req.headers, body };
        stub.requests.push(rec);
        const mode = stub.mode;
        if (mode === 'hang') return; // never answers: the client must time out
        const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
        const sameKind = stub.requests.filter((r) => r.url === req.url).length;
        if (mode === 'fail500once' && sameKind === 1) return reply(500, { name: 'application_error', message: 'boom' });
        if (mode === 'fail500') return reply(500, { name: 'application_error', message: 'boom' });
        if (mode === 'reject422') return reply(422, { name: 'validation_error', message: 'The domain is not verified' });
        reply(200, { id: 'stub-' + rnd() });
      });
    });
    stub.server.listen(0, '127.0.0.1', () => { stub.port = stub.server.address().port; resolve(); });
  });
}
const stubReset = (mode = 'ok') => { stub.requests = []; stub.mode = mode; };
const emailsTo = (addr) => stub.requests.filter((r) => r.url === '/emails' && r.body?.to?.includes(addr));
const codeFrom = (rec) => /\b(\d{6})\b/.exec(rec.body.text)[1];
const allCodesSent = [];
// Waits for the most recent email to `addr` and returns its code.
async function lastCode(addr) {
  const list = emailsTo(addr);
  assert.ok(list.length, `no email was sent to ${addr}`);
  const c = codeFrom(list[list.length - 1]); allCodesSent.push(c); return c;
}

// ------------------------------------------------------------------ server processes
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function startServer({ env = {}, label }) {
  const port = await freePort();
  fs.mkdirSync('/tmp/auth-email', { recursive: true });
  const logFile = `/tmp/auth-email/${label}-${RUN}.log`;
  const out = fs.openSync(logFile, 'a');
  const baseEnv = { ...process.env };
  for (const k of ['NODE_ENV', 'QB_TEST_NOW', 'QB_TEST_NOW_FROZEN', 'DEMO_MODE', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_URL', 'EMAIL_FROM', 'EMAIL_REPLY_TO',
    'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'WHATSAPP_PROVIDER', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN',
    'ADMIN_SESSION_HOURS', 'STAFF_SESSION_HOURS', 'OTP_PEPPER', 'APP_NAME']) delete baseEnv[k];
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
    await sleep(100);
  }
  throw new Error(`server ${label} did not start; see ${logFile}`);
}
const stopServer = (s) => new Promise((resolve) => { if (!s?.child || s.child.exitCode !== null) return resolve(); s.child.once('exit', resolve); s.child.kill('SIGTERM'); setTimeout(() => s.child.kill('SIGKILL'), 3000).unref(); });

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
  return { api, get: (p, o) => api('GET', p, o), post: (p, body, o = {}) => api('POST', p, { ...o, body }), patch: (p, body, o = {}) => api('PATCH', p, { ...o, body }), del: (p, o) => api('DELETE', p, o) };
}
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

let prod, closed, demo, dev;
const P = client(() => prod.base);
const C = client(() => closed.base);
const D = client(() => demo.base);
const V = client(() => dev.base);
const createdTenants = [];

const signupBody = (label, email) => ({
  businessName: `auth-email-${label}-${rnd()}`, firstName: 'Ann', lastName: 'Tester', email: email || `auth-email-${RUN}-${label}-${rnd()}@example.com`,
  locations: [{ name: 'Main' }], services: [{ name: 'Clinic', locationIndex: 0, mode: 'hybrid', slotMinutes: 15 }],
});
const tenantIdByEmail = (email) => sql(`select id from tenants where lower(email)=lower(${q(email)})`);

// Sign up + sign in on the production (real-email) instance, reading the code out of the stub's captured email.
async function prodAccount(label) {
  stub.mode = 'ok';
  const body = signupBody(label);
  const r = await P.post('/api/auth/signup', body);
  assert.equal(r.status, 200, r.text);
  const code = await lastCode(body.email);
  const v = await P.post('/api/auth/admin/verify-otp', { email: body.email, code });
  assert.equal(v.status, 200, v.text);
  createdTenants.push(v.json.tenant.id);
  return { email: body.email, token: v.json.token, id: v.json.tenant.id, body };
}
async function addStaffProd(t, label = 'staff') {
  const email = `auth-email-${RUN}-${label}-${rnd()}@example.com`;
  const r = await P.post('/api/tenant/staff', { firstName: 'Sam', lastName: 'Staff', email }, { token: t.token });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.staff.id, email };
}

before(async () => {
  await stubStart();
  const stubUrl = `http://127.0.0.1:${stub.port}`;
  prod = await startServer({
    label: 'prod',
    env: {
      NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: RESEND_KEY, RESEND_API_URL: `${stubUrl}/emails`,
      EMAIL_FROM: 'QBooker Test <login@mail.example.test>', EMAIL_REPLY_TO: 'help@example.test', APP_NAME: 'TestApp', OTP_PEPPER,
      EMAIL_TIMEOUT_MS: '400', EMAIL_RETRY_DELAY_MS: '20',
      WHATSAPP_PROVIDER: 'meta-cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_ID: WA_PHONE_ID, WHATSAPP_API_URL: stubUrl,
      WHATSAPP_APP_SECRET: WA_APP_SECRET, WHATSAPP_VERIFY_TOKEN: WA_VERIFY, WHATSAPP_RETRY_DELAY_MS: '20',
    },
  });
  closed = await startServer({ label: 'closed', env: { NODE_ENV: 'production', WHATSAPP_WEBHOOK_RATE_PER_MIN: '5' } });
  demo = await startServer({ label: 'demo', env: { NODE_ENV: 'production', DEMO_MODE: 'true' } });
  dev = await startServer({ label: 'dev', env: { NODE_ENV: 'test', ADMIN_SESSION_HOURS: '0.002', STAFF_SESSION_HOURS: '0.002' } });
});
after(async () => {
  try {
    const t = (await P.post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json?.token;
    if (t) for (const id of createdTenants) await P.del(`/api/system/tenants/${id}`, { token: t });
  } catch { /* best effort */ }
  for (const s of [prod, closed, demo, dev]) await stopServer(s);
  stub.server.closeAllConnections?.();
  await new Promise((r) => stub.server.close(r));
});

// =====================================================================================================
describe('provider selection (lib/email.js, lib/whatsapp.js)', () => {
  const KEYS = ['NODE_ENV', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'DEMO_MODE', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'WHATSAPP_PROVIDER', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'];
  let email, wa;
  const saved = {};
  before(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    email = await import('../src/lib/email.js');
    wa = await import('../src/lib/whatsapp.js');
  });
  after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const withEnv = (env, fn) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); return fn(); };

  it('test mode: the log provider is ready and codes may be shown', () => withEnv({ NODE_ENV: 'test' }, () => {
    assert.deepEqual([email.emailStatus().provider, email.emailStatus().ready, email.demoOtpAllowed()], ['log', true, true]);
  }));
  it('development (no NODE_ENV): log provider is ready but codes are NOT shown unless DEMO_MODE=true', () => {
    withEnv({}, () => assert.deepEqual([email.emailStatus().provider, email.emailStatus().ready, email.demoOtpAllowed()], ['log', true, false]));
    withEnv({ DEMO_MODE: 'true' }, () => assert.equal(email.demoOtpAllowed(), true));
  });
  it('production: nothing configured -> not ready (fail closed), no codes shown', () => withEnv({ NODE_ENV: 'production' }, () => {
    const s = email.emailStatus();
    assert.equal(s.ready, false); assert.match(s.reason, /EMAIL_PROVIDER is not set/); assert.equal(email.demoOtpAllowed(), false);
  }));
  it('production: the log provider alone is refused; with DEMO_MODE=true it works and may show codes', () => {
    withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'log' }, () => { assert.equal(email.emailStatus().ready, false); assert.equal(email.demoOtpAllowed(), false); });
    withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'log', DEMO_MODE: 'true' }, () => { assert.equal(email.emailStatus().ready, true); assert.equal(email.demoOtpAllowed(), true); });
  });
  it('a Railway deployment counts as production even without NODE_ENV', () => withEnv({ RAILWAY_ENVIRONMENT: 'production' }, () => {
    assert.equal(email.isProduction(), true); assert.equal(email.emailStatus().ready, false);
  }));
  it('resend needs both RESEND_API_KEY and EMAIL_FROM; never shows codes', () => {
    withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }, () => assert.equal(email.emailStatus().ready, false));
    withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'A <a@b.example>' }, () => { assert.equal(email.emailStatus().ready, true); assert.equal(email.demoOtpAllowed(), false); });
    // even in a test run: a real provider never exposes codes
    withEnv({ NODE_ENV: 'test', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'A <a@b.example>' }, () => assert.equal(email.demoOtpAllowed(), false));
  });
  it('an unknown provider name is not ready (and says why)', () => withEnv({ NODE_ENV: 'test', EMAIL_PROVIDER: 'carrier-pigeon' }, () => {
    assert.equal(email.emailStatus().ready, false); assert.match(email.emailStatus().reason, /not a known provider/);
  }));
  it('WhatsApp: log by default; meta-cloud needs token + phone id', () => {
    withEnv({}, () => assert.deepEqual([wa.whatsappStatus().provider, wa.whatsappStatus().ready], ['log', true]));
    withEnv({ WHATSAPP_PROVIDER: 'meta-cloud' }, () => assert.equal(wa.whatsappStatus().ready, false));
    withEnv({ WHATSAPP_PROVIDER: 'meta-cloud', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1' }, () => assert.equal(wa.whatsappStatus().ready, true));
  });
  it('the message catalogue: language fallback, placeholders, no HTML in strings', async () => {
    const i18n = await import('../src/lib/i18n.js');
    assert.equal(i18n.resolveLang('fr-CH, fr;q=0.9, en;q=0.8'), 'en');
    assert.equal(i18n.resolveLang('EN_gb'), 'en'); assert.equal(i18n.resolveLang(undefined), 'en'); assert.equal(i18n.resolveLang({}), 'en');
    assert.equal(i18n.t('en', 'whatsapp.call', { room: 'Room 4' }), "It's your turn! Please come to Room 4.");
    assert.equal(i18n.t('xx', 'email.otp.subject', { app: 'Acme' }), 'Your Acme sign-in code');
    assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key');
  });
  it('the email builder escapes HTML in app name and keeps the plain-text part free of markup', () => withEnv({ NODE_ENV: 'test' }, () => {
    process.env.APP_NAME = '<b>Evil</b> & Co';
    try {
      const m = email.buildMessage({ to: 'a@b.example', template: 'otp', lang: 'en', code: '123456', minutes: 10 });
      assert.doesNotMatch(m.html, /<b>Evil/); assert.match(m.html, /&lt;b&gt;Evil/);
      assert.match(m.text, /123456/); assert.match(m.html, /123456/);
      delete process.env.APP_NAME;
      assert.doesNotMatch(email.buildMessage({ to: 'a@b.example', template: 'otp', lang: 'en', code: '123456', minutes: 10 }).text, /<[a-z]/i, 'plain text part has no markup');
    } finally { delete process.env.APP_NAME; }
  }));
  it('the timing mirror waits about as long as real work took', async () => {
    const mirror = email.createLatencyMirror();
    await mirror.track(() => sleep(80));
    const t0 = Date.now(); await mirror.mimic(); const waited = Date.now() - t0;
    assert.ok(waited >= 50 && waited < 400, `waited ${waited}ms`);
  });
  it('the hash is keyed and bound to purpose and owner', async () => {
    const otp = await import('../src/lib/otp.js');
    const h = otp.hashOtp('admin', 'owner-1', '123456');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(otp.otpMatches(h, 'admin', 'owner-1', '123456'), true);
    assert.equal(otp.otpMatches(h, 'admin', 'owner-2', '123456'), false);
    assert.equal(otp.otpMatches(h, 'staff', 'owner-1', '123456'), false);
    assert.equal(otp.otpMatches(h, 'admin', 'owner-1', '123457'), false);
    assert.equal(otp.otpMatches('123456', 'admin', 'owner-1', '123456'), false, 'a clear-text value is never accepted as a hash');
    assert.equal(otp.otpMatches(undefined, 'admin', 'owner-1', '123456'), false);
  });
});

// =====================================================================================================
describe('real email: sign-up, request, delivery shape (production instance, stub Resend)', () => {
  it('sign-up emails the code through Resend with the right request, and answers without any code', async () => {
    stubReset();
    const body = signupBody('shape');
    const r = await P.post('/api/auth/signup', body);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['businessName', 'email', 'ok']);
    assert.equal(r.json.demoOtp, undefined); assert.equal(r.json.tenant, undefined); assert.equal(r.json.alreadyExists, undefined);
    createdTenants.push(tenantIdByEmail(body.email));
    const sends = emailsTo(body.email);
    assert.equal(sends.length, 1);
    const s = sends[0];
    assert.equal(s.method, 'POST'); assert.equal(s.url, '/emails');
    assert.equal(s.headers.authorization, `Bearer ${RESEND_KEY}`);
    assert.match(s.headers['content-type'], /application\/json/);
    assert.match(s.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.equal(s.body.from, 'QBooker Test <login@mail.example.test>'); assert.equal(s.body.reply_to, 'help@example.test');
    assert.deepEqual(s.body.to, [body.email]);
    assert.match(s.body.subject, /TestApp/); assert.match(s.body.text, /\b\d{6}\b/); assert.match(s.body.html, /<html/);
    assert.ok(s.body.html.includes(codeFrom(s)), 'html shows the same code');
    assert.doesNotMatch(s.body.text, /<[a-z]/i);
    assert.match(s.body.text, /expires in 10 minutes/);
  });

  it('request-otp for an existing account sends a code; the code signs in once and only once', async () => {
    const t = await prodAccount('req');
    stubReset();
    const r = await P.post('/api/auth/admin/request-otp', { email: t.email.toUpperCase() });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    const code = await lastCode(t.email);
    const v = await P.post('/api/auth/admin/verify-otp', { email: t.email, code });
    assert.equal(v.status, 200);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code })).status, 401, 'single use');
  });

  it('the language can be requested; unsupported languages fall back to English', async () => {
    const t = await prodAccount('lang');
    stubReset();
    await P.post('/api/auth/admin/request-otp', { email: t.email, lang: 'xx-YY' });
    assert.match(emailsTo(t.email)[0].body.html, /<html lang="en"/);
  });

  it('a new code cancels the previous one; expired codes are refused', async () => {
    const t = await prodAccount('cancel');
    stubReset();
    await P.post('/api/auth/admin/request-otp', { email: t.email }); const first = await lastCode(t.email);
    await P.post('/api/auth/admin/request-otp', { email: t.email }); const second = await lastCode(t.email);
    assert.notEqual(first, second);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code: first })).status, 401, 'older code must be dead');
    assert.equal(Number(sql(`select count(*) from admin_otp where tenant_id='${t.id}' and consumed=false and expires_at>now()`)), 1, 'exactly one live code');
    sql(`update admin_otp set expires_at = now() - interval '1 minute' where tenant_id='${t.id}'`);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code: second })).status, 401, 'expired');
  });

  it('five wrong guesses kill a code even if the right one follows', async () => {
    const t = await prodAccount('guess');
    stubReset();
    await P.post('/api/auth/admin/request-otp', { email: t.email }); const code = await lastCode(t.email);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code: wrong })).status, 401);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code })).status, 401);
  });

  it('codes are stored as 64-hex keyed hashes (admin and staff), never in clear; the message log holds no code', async () => {
    const t = await prodAccount('hash');
    const s = await addStaffProd(t);
    stubReset();
    await P.post('/api/auth/admin/request-otp', { email: t.email }); const adminCode = await lastCode(t.email);
    await P.post('/api/auth/staff/request-otp', { email: s.email }); const staffCode = await lastCode(s.email);
    const adminRows = sql(`select code from admin_otp where tenant_id='${t.id}'`).split('\n');
    const staffRows = sql(`select code from staff_otp where staff_id='${s.id}'`).split('\n');
    for (const row of [...adminRows, ...staffRows]) assert.match(row, /^[0-9a-f]{64}$/, 'stored value is a hash');
    assert.ok(!adminRows.includes(adminCode) && !staffRows.includes(staffCode));
    const crypto2 = await import('node:crypto');
    // keyed with OTP_PEPPER (not JWT_SECRET) and bound to the owner
    const expected = crypto2.createHmac('sha256', OTP_PEPPER).update(`admin\n${t.id}\n${adminCode}`).digest('hex');
    assert.ok(adminRows.includes(expected), 'HMAC-SHA256(OTP_PEPPER, purpose+owner+code)');
    for (const c of [adminCode, staffCode]) {
      assert.equal(Number(sql(`select count(*) from simulated_messages where body like '%${c}%'`)), 0, 'no code in simulated_messages');
    }
    // and the codes still work
    assert.equal((await P.post('/api/auth/staff/verify-otp', { email: s.email, code: staffCode })).status, 200);
  });

  it('staff: listed staff get a code by email; unlisted, switched-off and disabled-business addresses get nothing, with the same answer', async () => {
    const t = await prodAccount('staff');
    const s = await addStaffProd(t);
    const off = await addStaffProd(t, 'off');
    assert.equal((await P.patch(`/api/tenant/staff/${off.id}`, { active: false }, { token: t.token })).status, 200);
    stubReset();
    const answers = [];
    for (const email of [s.email, off.email, `auth-email-nobody-${rnd()}@example.com`]) answers.push(await P.post('/api/auth/staff/request-otp', { email }));
    for (const a of answers) { assert.equal(a.status, 200); assert.deepEqual(a.json, { ok: true }); }
    assert.equal(emailsTo(s.email).length, 1);
    assert.equal(emailsTo(off.email).length, 0); assert.equal(stub.requests.filter((r) => r.url === '/emails').length, 1);
    const code = await lastCode(s.email);
    const v = await P.post('/api/auth/staff/verify-otp', { email: s.email, code });
    assert.equal(v.status, 200); assert.equal(v.json.demoOtp, undefined);
  });
});

// =====================================================================================================
describe('account enumeration: identical answers for known and unknown addresses', () => {
  it('admin/request-otp: same status, same body, same header set for a real and an invented address', async () => {
    const t = await prodAccount('enum');
    stubReset();
    const known = await P.post('/api/auth/admin/request-otp', { email: t.email });
    const unknown = await P.post('/api/auth/admin/request-otp', { email: `auth-email-nobody-${rnd()}@example.com` });
    assert.equal(known.status, 200); assert.equal(unknown.status, 200);
    assert.equal(known.text, unknown.text);
    const names = (r) => [...r.headers.keys()].filter((h) => !['date', 'content-length', 'etag', 'x-ratelimit-remaining'].includes(h)).sort();
    assert.deepEqual(names(known), names(unknown));
    assert.equal(emailsTo(t.email).length, 1);
  });

  it('admin/verify-otp: unknown address and wrong code are the same 401', async () => {
    const t = await prodAccount('enum2');
    const a = await P.post('/api/auth/admin/verify-otp', { email: t.email, code: '000000' });
    const b = await P.post('/api/auth/admin/verify-otp', { email: `auth-email-nobody-${rnd()}@example.com`, code: '000000' });
    assert.deepEqual([a.status, a.text], [b.status, b.text]); assert.equal(a.status, 401);
  });

  it('timing: the unknown-address path is not measurably faster than the known one', async () => {
    const t = await prodAccount('timing');
    stubReset();
    const time = async (email) => { const s = process.hrtime.bigint(); await P.post('/api/auth/admin/request-otp', { email }); return Number(process.hrtime.bigint() - s) / 1e6; };
    for (let i = 0; i < 3; i++) { await time(t.email); await time(`auth-email-nobody-${rnd()}@example.com`); } // warm up and let the mirror learn
    const known = [], unknown = [];
    for (let i = 0; i < 6; i++) { known.push(await time(t.email)); unknown.push(await time(`auth-email-nobody-${rnd()}@example.com`)); }
    const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    // The stub answers in ~1 ms so both are tiny; what matters is that the unknown path is not a different order of magnitude.
    assert.ok(Math.abs(median(known) - median(unknown)) < 40, `known ${median(known).toFixed(1)}ms vs unknown ${median(unknown).toFixed(1)}ms`);
  });

  it('sign-up with an existing address answers like a new sign-up, and emails the owner a code plus an "already have an account" notice', async () => {
    const t = await prodAccount('dup');
    stubReset();
    const fresh = signupBody('dupnew');
    const a = await P.post('/api/auth/signup', fresh);
    createdTenants.push(tenantIdByEmail(fresh.email));
    const b = await P.post('/api/auth/signup', { ...t.body, businessName: 'a different name', email: t.email.toUpperCase() });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.deepEqual(Object.keys(a.json).sort(), Object.keys(b.json).sort());
    assert.equal(b.json.alreadyExists, undefined); assert.equal(b.json.demoOtp, undefined); assert.equal(b.json.tenant, undefined);
    assert.equal(b.json.businessName, 'a different name', 'the response only echoes what the visitor typed, never the stored name');
    assert.equal(Number(sql(`select count(*) from tenants where lower(email)=lower(${q(t.email)})`)), 1, 'no duplicate account');
    const mail = emailsTo(t.email);
    assert.equal(mail.length, 1);
    assert.match(mail[0].body.subject, /already have/i); assert.match(mail[0].body.text, /account already exists/i);
    const v = await P.post('/api/auth/admin/verify-otp', { email: t.email, code: codeFrom(mail[0]) });
    assert.equal(v.status, 200, 'the emailed code signs the owner in');
  });

  it('a switched-off account gets a notice by email, no code, and the same answers everywhere', async () => {
    const t = await prodAccount('off');
    const st = (await P.post('/api/auth/system/login', { password: SYSTEM_PASSWORD })).json.token;
    assert.equal((await P.patch(`/api/system/tenants/${t.id}`, { status: 'disabled' }, { token: st })).status, 200);
    stubReset();
    const rq = await P.post('/api/auth/admin/request-otp', { email: t.email });
    const su = await P.post('/api/auth/signup', { ...t.body, email: t.email });
    assert.equal(rq.status, 200); assert.deepEqual(rq.json, { ok: true }); assert.equal(su.status, 200);
    const mails = emailsTo(t.email);
    assert.equal(mails.length, 2);
    for (const m of mails) { assert.match(m.body.subject, /switched off/i); assert.doesNotMatch(m.body.text, /\b\d{6}\b/); }
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code: '123456' })).status, 401);
    await P.patch(`/api/system/tenants/${t.id}`, { status: 'active' }, { token: st });
  });
});

// =====================================================================================================
describe('delivery failures: retries, 503, throttle budget, no secrets in the log', () => {
  it('a provider 5xx is retried once and the sign-in still succeeds', async () => {
    const t = await prodAccount('retry');
    stubReset('fail500once');
    const r = await P.post('/api/auth/admin/request-otp', { email: t.email });
    assert.equal(r.status, 200);
    const sends = emailsTo(t.email);
    assert.equal(sends.length, 2, 'one failed attempt + one retry');
    assert.equal(sends[0].headers['idempotency-key'], sends[1].headers['idempotency-key'], 'same idempotency key so a double delivery cannot happen');
    const code = await lastCode(t.email);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: t.email, code })).status, 200);
  });

  it('a provider that keeps failing -> clean 503 after exactly 2 attempts, with the plain "try again" message', async () => {
    const t = await prodAccount('fail');
    stubReset('fail500');
    const r = await P.post('/api/auth/admin/request-otp', { email: t.email });
    assert.equal(r.status, 503); assert.match(r.json.error, /couldn't send the code/i); assert.ok(r.headers.get('retry-after'));
    assert.equal(emailsTo(t.email).length, 2);
    assert.doesNotMatch(r.text, /boom|resend|re_test|stack|\bat \w+/i, 'no provider detail leaks to the visitor');
  });

  it('a 4xx from the provider (bad key / unverified domain) is not retried and is a 503 too', async () => {
    const t = await prodAccount('reject');
    stubReset('reject422');
    const r = await P.post('/api/auth/admin/request-otp', { email: t.email });
    assert.equal(r.status, 503);
    assert.equal(emailsTo(t.email).length, 1);
  });

  it('a provider that never answers is cut off by the timeout (503), not left hanging', async () => {
    const t = await prodAccount('hang');
    stubReset('hang');
    const t0 = Date.now();
    const r = await P.post('/api/auth/admin/request-otp', { email: t.email });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
    assert.equal(emailsTo(t.email).length, 2, 'timeout counts as a network failure: one retry');
    stubReset();
  });

  it('failed sends do not use up the caller\'s throttle budget (15 failures from one connection, then it still works)', async () => {
    const t = await prodAccount('budget');
    const ip = randIp();
    stubReset('reject422');
    for (let i = 0; i < 15; i++) assert.equal((await P.post('/api/auth/admin/request-otp', { email: t.email }, { ip })).status, 503, `attempt ${i + 1}`);
    stubReset();
    assert.equal((await P.post('/api/auth/admin/request-otp', { email: t.email }, { ip })).status, 200, 'budget was refunded');
    // while successful requests still hit the limit
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) limited = (await P.post('/api/auth/admin/request-otp', { email: t.email }, { ip })).status === 429;
    assert.ok(limited, 'the throttle itself still works');
  });

  it('a failed sign-up send says 503, keeps the account, and signing up again (or signing in) delivers a fresh code', async () => {
    const body = signupBody('failsignup');
    stubReset('reject422');
    const r = await P.post('/api/auth/signup', body);
    assert.equal(r.status, 503);
    assert.equal(Number(sql(`select count(*) from tenants where lower(email)=lower(${q(body.email)})`)), 1);
    createdTenants.push(tenantIdByEmail(body.email));
    stubReset();
    assert.equal((await P.post('/api/auth/signup', body)).status, 200);
    const code = await lastCode(body.email);
    assert.equal((await P.post('/api/auth/admin/verify-otp', { email: body.email, code })).status, 200);
  });

  it('the server log never contains the API key, any code that was sent, the JWT secret or the pepper', async () => {
    stubReset();
    const t = await prodAccount('logscan');
    stubReset('fail500'); await P.post('/api/auth/admin/request-otp', { email: t.email }); stubReset();
    await P.post('/api/auth/admin/request-otp', { email: t.email }); await lastCode(t.email);
    await sleep(200);
    const log = fs.readFileSync(prod.logFile, 'utf8');
    for (const secret of [RESEND_KEY, JWT_SECRET, OTP_PEPPER, WA_TOKEN, WA_APP_SECRET, WA_VERIFY, SYSTEM_PASSWORD, t.token]) assert.equal(log.includes(secret), false, `log contains ${secret.slice(0, 10)}...`);
    assert.ok(allCodesSent.length >= 5);
    for (const c of allCodesSent) assert.equal(new RegExp(`(?<!\\d)${c}(?!\\d)`).test(log), false, `code ${c} found in the log`);
    assert.match(log, /\[email\] resend rejected a message \(HTTP 5\d\d/, 'failures are logged (status only)');
    assert.doesNotMatch(log, /Idempotency|Bearer /i);
  });
});

// =====================================================================================================
describe('codes are never returned over HTTP in production', () => {
  it('production + real provider: no response from any sign-in endpoint carries a code or a "demo" field', async () => {
    const t = await prodAccount('plain');
    const s = await addStaffProd(t);
    stubReset();
    const responses = [
      await P.post('/api/auth/signup', signupBody('plain2')),
      await P.post('/api/auth/admin/request-otp', { email: t.email }),
      await P.post('/api/auth/staff/request-otp', { email: s.email }),
      await P.post('/api/auth/staff/request-otp', { email: 'nobody@example.com' }),
      await P.post('/api/auth/admin/verify-otp', { email: t.email, code: '000000' }),
    ];
    createdTenants.push(...sql(`select id from tenants where business_name like 'auth-email-plain2%'`).split('\n').filter(Boolean));
    for (const r of responses) { assert.doesNotMatch(r.text, /demo|"code"|\b\d{6}\b/i, r.text); }
    const sent = [await lastCode(t.email), await lastCode(s.email)];
    for (const c of sent) for (const r of responses) assert.ok(!r.text.includes(c));
  });

  it('production with nothing configured fails closed: sign-in, staff sign-in and sign-up answer 503 (no codes, no accounts created)', async () => {
    const email = `auth-email-closed-${RUN}-${rnd()}@example.com`;
    const a = await C.post('/api/auth/admin/request-otp', { email });
    const b = await C.post('/api/auth/staff/request-otp', { email });
    const body = signupBody('closed', email);
    const c = await C.post('/api/auth/signup', body);
    for (const r of [a, b, c]) { assert.equal(r.status, 503, r.text); assert.match(r.json.error, /isn't switched on/i); assert.equal(r.json.demoOtp, undefined); assert.doesNotMatch(r.text, /\b\d{6}\b/); }
    assert.equal(Number(sql(`select count(*) from tenants where lower(email)=lower(${q(email)})`)), 0, 'sign-up created nothing');
    assert.equal((await C.get('/health')).status, 200, 'the server itself stays up');
  });

  it('the closed server says so loudly at boot, without crashing', () => {
    const log = fs.readFileSync(closed.logFile, 'utf8');
    assert.match(log, /EMAIL IS NOT SET UP/); assert.match(log, /EMAIL_PROVIDER is not set/); assert.match(log, /listening on port/);
  });

  it('closed-server refusals use no throttle budget (30 refusals, still 503 not 429)', async () => {
    const ip = randIp(); const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add((await C.post('/api/auth/admin/request-otp', { email: 'x@example.com' }, { ip })).status);
    assert.deepEqual([...seen], [503]);
  });

  it('DEMO_MODE=true (log provider) is the only production-like setup that returns a code, and it still stores it hashed', async () => {
    const body = signupBody('demo');
    const r = await D.post('/api/auth/signup', body);
    assert.equal(r.status, 200, r.text); assert.match(r.json.demoOtp, /^\d{6}$/);
    createdTenants.push(r.json.tenant.id);
    assert.match(sql(`select code from admin_otp where tenant_id='${r.json.tenant.id}'`), /^[0-9a-f]{64}$/);
    assert.equal((await D.post('/api/auth/admin/verify-otp', { email: body.email, code: r.json.demoOtp })).status, 200);
    assert.match(fs.readFileSync(demo.logFile, 'utf8'), /DEMO_MODE=true with the log email provider/);
  });
});

// =====================================================================================================
describe('sessions: lifetime, sliding refresh, sign out everywhere', () => {
  it('default lifetimes: admin 12h, staff 16h; claims are role, ids, token version and sign-in time only', async () => {
    const t = await prodAccount('life');
    const a = decodeJwt(t.token);
    assert.equal(a.exp - a.iat, 12 * 3600);
    assert.deepEqual(Object.keys(a).sort(), ['at', 'exp', 'iat', 'role', 'tenantId', 'tv']);
    const s = await addStaffProd(t); stubReset();
    await P.post('/api/auth/staff/request-otp', { email: s.email });
    const v = await P.post('/api/auth/staff/verify-otp', { email: s.email, code: await lastCode(s.email) });
    const sc = decodeJwt(v.json.token);
    assert.equal(sc.exp - sc.iat, 16 * 3600); assert.equal(sc.staffId, s.id);
  });

  it('a fresh session gets no refresh header; one that has used half its life gets a new token that works and keeps the original sign-in time', async () => {
    const email = `auth-email-${RUN}-slide-${rnd()}@example.com`;
    const su = await V.post('/api/auth/signup', { ...signupBody('slide', email) });
    assert.equal(su.status, 200, su.text); createdTenants.push(su.json.tenant.id);
    const v = await V.post('/api/auth/admin/verify-otp', { email, code: su.json.demoOtp });
    const tok = v.json.token; const c0 = decodeJwt(tok);
    assert.ok(c0.exp - c0.iat >= 7 && c0.exp - c0.iat <= 8, `lifetime ${c0.exp - c0.iat}s`); // 0.002 h
    const early = await V.get('/api/tenant/me', { token: tok });
    assert.equal(early.status, 200); assert.equal(early.headers.get('x-session-token'), null);
    await sleep(4200); // past half of 7.2 s
    const later = await V.get('/api/tenant/me', { token: tok });
    assert.equal(later.status, 200);
    const fresh = later.headers.get('x-session-token');
    assert.ok(fresh, 'refresh header present');
    const c1 = decodeJwt(fresh);
    assert.ok(c1.exp > c0.exp, 'new expiry is later'); assert.equal(c1.at, c0.at, 'original sign-in time is kept'); assert.equal(c1.tenantId, c0.tenantId); assert.equal(c1.tv, c0.tv);
    assert.equal((await V.get('/api/tenant/me', { token: fresh })).status, 200);
    // CORS: the browser app may read the header
    const cors = await V.get('/api/tenant/me', { token: tok, headers: { origin: 'http://localhost:5173' } });
    assert.match(cors.headers.get('access-control-expose-headers') || '', /X-Session-Token/i);
    // an expired token is not revived
    await sleep(8000);
    assert.equal((await V.get('/api/tenant/me', { token: tok })).status, 401);
  });

  it('staff kiosk sessions slide too, and a removed staff member cannot refresh', async () => {
    const email = `auth-email-${RUN}-kiosk-${rnd()}@example.com`;
    const su = await V.post('/api/auth/signup', { ...signupBody('kiosk', email) });
    createdTenants.push(su.json.tenant.id);
    const admin = (await V.post('/api/auth/admin/verify-otp', { email, code: su.json.demoOtp })).json.token;
    const sEmail = `auth-email-${RUN}-ks-${rnd()}@example.com`;
    const added = await V.post('/api/tenant/staff', { firstName: 'K', lastName: 'Iosk', email: sEmail }, { token: admin });
    // the admin token may already be past half: that is fine; use whatever token the server returns
    assert.equal(added.status, 200, added.text);
    const rq = await V.post('/api/auth/staff/request-otp', { email: sEmail });
    const v = await V.post('/api/auth/staff/verify-otp', { email: sEmail, code: rq.json.demoOtp });
    assert.equal(v.status, 200);
    await sleep(4200);
    const r = await V.get('/api/tenant/me', { token: v.json.token });
    assert.equal(r.status, 200); assert.ok(r.headers.get('x-session-token'), 'kiosk got a fresh token');
  });

  it('sign out everywhere (admin): every earlier admin token dies, a new sign-in works; staff are untouched unless asked', async () => {
    const t = await prodAccount('soe');
    const s = await addStaffProd(t); stubReset();
    await P.post('/api/auth/staff/request-otp', { email: s.email });
    const staffTok = (await P.post('/api/auth/staff/verify-otp', { email: s.email, code: await lastCode(s.email) })).json.token;
    // a second admin session
    await P.post('/api/auth/admin/request-otp', { email: t.email });
    const second = (await P.post('/api/auth/admin/verify-otp', { email: t.email, code: await lastCode(t.email) })).json.token;
    assert.equal((await P.get('/api/tenant/me', { token: second })).status, 200);
    assert.equal((await P.post('/api/auth/sign-out-everywhere', {}, { token: t.token })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: t.token })).status, 401);
    assert.equal((await P.get('/api/tenant/me', { token: second })).status, 401);
    assert.equal((await P.get('/api/tenant/me', { token: staffTok })).status, 200, 'staff session unaffected');
    await P.post('/api/auth/admin/request-otp', { email: t.email });
    const fresh = (await P.post('/api/auth/admin/verify-otp', { email: t.email, code: await lastCode(t.email) })).json.token;
    assert.equal((await P.get('/api/tenant/me', { token: fresh })).status, 200);
    assert.equal((await P.post('/api/auth/sign-out-everywhere', { includeStaff: true }, { token: fresh })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: staffTok })).status, 401, 'includeStaff ends staff sessions too');
  });

  it('an admin can sign one staff member out; switching a staff member off ends their sessions for good, even after switching back on', async () => {
    const t = await prodAccount('soestaff');
    const a = await addStaffProd(t, 'a'); const b = await addStaffProd(t, 'b');
    const login = async (s) => { stubReset(); await P.post('/api/auth/staff/request-otp', { email: s.email }); return (await P.post('/api/auth/staff/verify-otp', { email: s.email, code: await lastCode(s.email) })).json.token; };
    const ta = await login(a); const tb = await login(b);
    assert.equal((await P.post(`/api/auth/staff/${a.id}/sign-out`, {}, { token: t.token })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: ta })).status, 401); assert.equal((await P.get('/api/tenant/me', { token: tb })).status, 200);
    // staff cannot use the admin-only endpoint; another tenant's staff id is a 404
    assert.equal((await P.post(`/api/auth/staff/${b.id}/sign-out`, {}, { token: tb })).status, 403);
    const other = await prodAccount('soeother');
    assert.equal((await P.post(`/api/auth/staff/${b.id}/sign-out`, {}, { token: other.token })).status, 404);
    assert.equal((await P.get('/api/tenant/me', { token: tb })).status, 200, 'the other tenant did not sign b out');
    // disable -> old token dead; re-enable -> still dead
    assert.equal((await P.patch(`/api/tenant/staff/${b.id}`, { active: false }, { token: t.token })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: tb })).status, 401);
    assert.equal((await P.patch(`/api/tenant/staff/${b.id}`, { active: true }, { token: t.token })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: tb })).status, 401, 'token from before the switch-off stays dead');
    assert.ok(await login(b), 'but a new sign-in works');
  });

  it('a staff member can sign themselves out everywhere', async () => {
    const t = await prodAccount('soeself'); const s = await addStaffProd(t); stubReset();
    await P.post('/api/auth/staff/request-otp', { email: s.email });
    const tok = (await P.post('/api/auth/staff/verify-otp', { email: s.email, code: await lastCode(s.email) })).json.token;
    assert.equal((await P.post('/api/auth/sign-out-everywhere', {}, { token: tok })).status, 200);
    assert.equal((await P.get('/api/tenant/me', { token: tok })).status, 401);
  });

  it('sign-out endpoints need a session', async () => {
    assert.equal((await P.post('/api/auth/sign-out-everywhere', {})).status, 401);
    assert.equal((await P.post(`/api/auth/staff/${crypto.randomUUID()}/sign-out`, {})).status, 401);
  });
});

// =====================================================================================================
describe('WhatsApp webhook: signature, handshake, no CORS, rate limit, outbound provider', () => {
  const sign = (raw, secret = WA_APP_SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const metaPayload = (from, text, phoneId = WA_PHONE_ID) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001', phone_number_id: phoneId }, messages: [{ from, id: 'wamid.' + rnd(), type: 'text', text: { body: text } }] } }] }],
  });
  const signed = (raw, o = {}) => P.api('POST', '/api/whatsapp/webhook', { rawBody: raw, headers: { 'x-hub-signature-256': sign(raw), ...(o.headers || {}) } });
  const phone = () => '4470' + crypto.randomInt(10000000, 99999999);

  it('GET handshake: right verify token echoes the challenge; wrong / missing token or mode is refused', async () => {
    const q1 = (o) => P.get('/api/whatsapp/webhook?' + new URLSearchParams(o).toString());
    const ok = await q1({ 'hub.mode': 'subscribe', 'hub.verify_token': WA_VERIFY, 'hub.challenge': '1158201444' });
    assert.equal(ok.status, 200); assert.equal(ok.text, '1158201444'); assert.match(ok.headers.get('content-type'), /text\/plain/);
    assert.equal((await q1({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status, 403);
    assert.equal((await q1({ 'hub.mode': 'subscribe', 'hub.challenge': '1' })).status, 403);
    assert.equal((await q1({ 'hub.mode': 'unsubscribe', 'hub.verify_token': WA_VERIFY, 'hub.challenge': '1' })).status, 403);
    assert.equal((await q1({ 'hub.mode': 'subscribe', 'hub.verify_token': WA_VERIFY, 'hub.challenge': '<script>' })).status, 403, 'a challenge that is not a plain token is never echoed');
    assert.equal((await C.get('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 503, 'no verify token configured -> refused');
  });

  it('POST: unsigned, wrongly signed, malformed-signature and tampered bodies are all 401; nothing is stored', async () => {
    const from = phone();
    const raw = metaPayload(from, 'hello QB-AAAAAA');
    const no = await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw });
    assert.equal(no.status, 401);
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw, headers: { 'x-hub-signature-256': sign(raw, 'wrong-secret') } })).status, 401);
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw, headers: { 'x-hub-signature-256': 'sha256=zz' } })).status, 401);
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw, headers: { 'x-hub-signature-256': sign(raw).replace('sha256=', '') } })).status, 401, 'prefix required');
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw.replace('hello', 'HELLO'), headers: { 'x-hub-signature-256': sign(raw) } })).status, 401, 'tampered');
    // a signature over the simplified shape does not rescue a body that is not what was signed either
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: JSON.stringify({ from, text: 'x' }), headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } })).status, 401);
    assert.equal(Number(sql(`select count(*) from whatsapp_sessions where phone_number=${q(from)}`)), 0);
  });

  it('POST: a correctly signed Meta payload is accepted, links the phone to the location, and answers with a bare acknowledgement (no tenant data)', async () => {
    const t = await prodAccount('wa');
    const loc = (await P.get('/api/tenant/locations', { token: t.token })).json.locations[0];
    const from = phone();
    const r = await signed(metaPayload(from, `hi ${loc.code.toLowerCase()} please`));
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    assert.doesNotMatch(r.text, new RegExp(`${t.id}|${loc.id}|${loc.code}`));
    assert.equal(sql(`select tenant_id from whatsapp_sessions where phone_number=${q(from)}`), t.id);
    // a follow-up with no code keeps the session and still leaks nothing
    const r2 = await signed(metaPayload(from, 'next'));
    assert.deepEqual(r2.json, { ok: true });
    // simplified { from, text } shape also works when signed, with the same minimal answer
    const raw = JSON.stringify({ from: phone(), text: `QB-ZZZZZZ` });
    const r3 = await signed(raw); assert.equal(r3.status, 200); assert.deepEqual(r3.json, { ok: true });
    assert.equal((await P.api('POST', '/api/whatsapp/webhook', { rawBody: '{"from":"1"}', headers: { 'x-hub-signature-256': sign('{"from":"1"}') } })).status, 400, 'missing text');
  });

  it('POST: events for a different business number are ignored; status updates are acknowledged', async () => {
    const t = await prodAccount('wa2');
    const loc = (await P.get('/api/tenant/locations', { token: t.token })).json.locations[0];
    const from = phone();
    const r = await signed(metaPayload(from, loc.code, '999999999'));
    assert.equal(r.status, 200);
    assert.equal(Number(sql(`select count(*) from whatsapp_sessions where phone_number=${q(from)}`)), 0, 'not our number');
    const status = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, statuses: [{ id: 'x', status: 'delivered' }] } }] }] });
    assert.equal((await signed(status)).status, 200);
  });

  it('a stranger\'s first message gets exactly one "scan the QR code" reply through the configured provider', async () => {
    stubReset();
    const from = phone();
    assert.equal((await signed(metaPayload(from, 'hello there'))).status, 200);
    const mine = () => stub.requests.filter((r) => r.url.includes('/messages') && r.body?.to === from);
    for (let i = 0; i < 30 && !mine().length; i++) await sleep(50);
    const msgs = mine();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].url, `/v21.0/${WA_PHONE_ID}/messages`);
    assert.equal(msgs[0].headers.authorization, `Bearer ${WA_TOKEN}`);
    assert.equal(msgs[0].body.messaging_product, 'whatsapp'); assert.equal(msgs[0].body.to, from); assert.equal(msgs[0].body.type, 'text');
    assert.match(msgs[0].body.text.body, /scan the QR code/);
    await signed(metaPayload(from, 'hello again')); await sleep(300);
    assert.equal(mine().length, 1, 'no second reply within 10 minutes');
  });

  it('the webhook sends no CORS headers at all (not even for a browser preflight)', async () => {
    const raw = metaPayload(phone(), 'x');
    const r = await P.api('POST', '/api/whatsapp/webhook', { rawBody: raw, headers: { 'x-hub-signature-256': sign(raw), origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const pre = await P.api('OPTIONS', '/api/whatsapp/webhook', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    const g = await P.get('/api/whatsapp/webhook', { headers: { origin: 'https://evil.example' } });
    assert.equal(g.headers.get('access-control-allow-origin'), null);
  });

  it('production with no WHATSAPP_APP_SECRET refuses every POST (503) instead of trusting unsigned calls; the rate limit applies first', async () => {
    const ip = randIp(); const seen = [];
    for (let i = 0; i < 8; i++) seen.push((await C.post('/api/whatsapp/webhook', { from: '447000000000', text: 'hello' }, { ip })).status);
    assert.deepEqual(seen, [503, 503, 503, 503, 503, 429, 429, 429]);
    assert.equal(Number(sql(`select count(*) from whatsapp_sessions where phone_number='447000000000'`)), 0);
  });

  it('outbound meta-cloud sender: request shape, retry on 5xx, failure -> WhatsAppError, no token in the log', async () => {
    const wa = await import('../src/lib/whatsapp.js');
    const keep = { ...process.env };
    Object.assign(process.env, { WHATSAPP_PROVIDER: 'meta-cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_ID: '777', WHATSAPP_API_URL: `http://127.0.0.1:${stub.port}`, WHATSAPP_RETRY_DELAY_MS: '10' });
    try {
      stubReset('fail500once');
      await wa.sendWhatsApp({ to: '+44 7000 000001', text: 'It\'s your turn!' });
      const reqs = stub.requests.filter((r) => r.url === '/v21.0/777/messages');
      assert.equal(reqs.length, 2); assert.equal(reqs[1].body.to, '447000000001'); assert.equal(reqs[1].body.text.body, "It's your turn!");
      stubReset('reject422');
      await assert.rejects(() => wa.sendWhatsApp({ to: '1', text: 'x' }), { name: 'WhatsAppError' });
      assert.equal(stub.requests.length, 1, '4xx not retried');
      stubReset('ok');
    } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
  });
});
