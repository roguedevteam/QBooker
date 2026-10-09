// WhatsApp ticket linking (simulation mode). Run against an API started as for the other suites:
//   . test/env.sh; export NODE_ENV=test EMAIL_PROVIDER=log; node --import ../e2e/dns-stub.mjs src/index.js
//   BASE_URL=http://localhost:4100 node --test server/test/whatsapp-link.test.mjs   (needs DATABASE_URL for the direct purge calls)
//
// What is proven here: no phone number is ever asked for; a number is attached to ONE ticket only by sending that ticket's code from WhatsApp;
// another number cannot take over; "your turn" and "you're next" go to the linked number; STOP deletes it; and numbers are deleted when
// a ticket is completed / cancelled, at the end of the day, and after 24 hours (a no-show is kept until the end of the day).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
const PG = { host: process.env.PGHOST || '/tmp/pgtest', port: process.env.PGPORT || '5433', db: process.env.PGDATABASE || 'qb_test', user: process.env.PGUSER || 'postgres' };
const sql = (q) => execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rnd = () => crypto.randomBytes(4).toString('hex');
const ri = (n) => crypto.randomInt(n);
const randIp = () => `10.${ri(250) + 1}.${ri(250) + 1}.${ri(250) + 1}`;
const b64u = (b) => Buffer.from(b).toString('base64url');
const forge = (payload) => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload)); return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`; };
async function api(method, path, { token, body } = {}) {
  const h = { 'x-forwarded-for': randIp() }; if (token) h.authorization = `Bearer ${token}`; if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(100); } }

const RUN = rnd();
const PREFIX = `wa-link-${RUN}`;
let tid, locId, svcId, tenantToken, purge, pool;
const phone = () => `4477${String(ri(100000000)).padStart(8, '0')}`;
const last4 = (p) => p.slice(-4);

function newTicket(num, { status = 'waiting', visitDate } = {}) {
  const id = sql(`insert into tickets (tenant_id, service_id, location_id, ticket_number, type, status${visitDate ? ', visit_date' : ''}) values ('${tid}','${svcId}','${locId}',${q(num)},'walk_in',${q(status)}${visitDate ? `,${q(visitDate)}` : ''}) returning id`);
  const token = crypto.randomBytes(24).toString('base64url');
  sql(`insert into ticket_web_access (token, ticket_id, tenant_id) values (${q(token)}, '${id}', '${tid}')`);
  return { id, token, num };
}
const view = (t) => api('GET', `/api/public/ticket/${t.token}`);
const hook = (from, text) => api('POST', '/api/whatsapp/webhook', { body: { from, text } });
const linkRow = (t) => JSON.parse(sql(`select coalesce(json_agg(k), '[]') from ticket_whatsapp_links k where ticket_id='${t.id}'`))[0];
const sent = (p) => JSON.parse(sql(`select coalesce(json_agg(m order by created_at), '[]') from simulated_messages m where tenant_id='${tid}' and to_reference = 'whatsapp:...${last4(p)}'`));
async function connected(t, p = phone()) { const code = (await view(t)).json.whatsappLinkCode; const r = await hook(p, `QBooker code: ${code}`); assert.equal(r.json.linked, true, r.text); return { p, code }; }

before(async () => {
  tid = sql(`insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name) values (${q(PREFIX)},${q(`${PREFIX}@example.com`)},1,${q('A' + rnd())},'card','active','Wa','Tester') returning id`);
  locId = sql(`insert into locations (tenant_id,name,address,staff_access_code) values ('${tid}','Main','',${q(rnd() + '-' + rnd())}) returning id`);
  svcId = sql(`insert into services (tenant_id,location_id,name,mode,slot_minutes) values ('${tid}','${locId}','Dental Care','queue',15) returning id`);
  tenantToken = forge({ role: 'tenant_admin', tenantId: tid, tv: 0, at: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  ({ purgeWhatsAppNumbers: purge } = await import('../src/lib/whatsappLinks.js'));
  ({ pool } = await import('../src/db/pool.js'));
});
after(async () => { try { sql(`delete from tenants where id='${tid}'`); } catch { /* */ } try { await pool?.end(); } catch { /* */ } });

describe('WhatsApp ticket links (simulation mode)', () => {
  it('a live ticket gets a link code with no phone number; an ended one does not', async () => {
    const t = newTicket('WA-001');
    const a = (await view(t)).json, b = (await view(t)).json;
    assert.match(a.whatsappLinkCode, /^QT-[A-Z2-9]{6}$/); assert.equal(a.whatsappLinkCode, b.whatsappLinkCode, 'stable');
    assert.equal(a.whatsappConnected, false);
    assert.equal(linkRow(t).phone_number, null);
    const done = newTicket('WA-002', { status: 'completed' });
    assert.equal((await view(done)).json.whatsappLinkCode, null);
  });

  it('whatsapp-intent never accepts a number and returns the same code', async () => {
    const t = newTicket('WA-003');
    const r = await api('POST', `/api/public/ticket/${t.token}/whatsapp-intent`, { body: { phone: '447700900123' } });
    assert.equal(r.status, 200); assert.equal(r.json.linkCode, (await view(t)).json.whatsappLinkCode);
    assert.equal(linkRow(t).phone_number, null, 'a number in the body is ignored');
  });

  it('sending the code from WhatsApp attaches that number to that ticket and confirms by message', async () => {
    const t = newTicket('WA-004'); const { p } = await connected(t);
    assert.equal(linkRow(t).phone_number, p);
    assert.equal((await view(t)).json.whatsappConnected, true);
    const m = await waitFor(async () => sent(p).find((x) => /WA-004/.test(x.body)));
    assert.ok(m, 'confirmation logged'); assert.match(m.body, /STOP/);
    assert.ok(!JSON.stringify(sent(p)).includes(p), 'the full number is never written to the message log');
  });

  it('the code works from a longer or lower-case message', async () => {
    const t = newTicket('WA-005'); const code = (await view(t)).json.whatsappLinkCode; const p = phone();
    assert.equal((await hook(p, `hi there ${code.toLowerCase()} thanks`)).json.linked, true);
  });

  it('another number cannot take over a connected ticket, and gets no reply', async () => {
    const t = newTicket('WA-006'); const { p, code } = await connected(t); const intruder = phone();
    const r = await hook(intruder, code);
    assert.equal(r.json.linkTaken, true); assert.equal(linkRow(t).phone_number, p);
    await sleep(300); assert.equal(sent(intruder).length, 0);
  });

  it('the same number sending the code again is fine', async () => {
    const t = newTicket('WA-007'); const { p, code } = await connected(t);
    assert.equal((await hook(p, code)).json.linked, true); assert.equal(linkRow(t).phone_number, p);
  });

  it('an unknown code or an ended ticket does not connect anything', async () => {
    const p = phone();
    assert.equal((await hook(p, 'QT-ZZZZZZ')).json.linked, undefined);
    const t = newTicket('WA-008'); const code = (await view(t)).json.whatsappLinkCode;
    sql(`update tickets set status='completed' where id='${t.id}'`);
    const r = await hook(p, code); assert.equal(r.json.linkExpired, true); assert.equal(linkRow(t).phone_number, null);
    const y = newTicket('WA-009'); const c2 = (await view(y)).json.whatsappLinkCode;
    sql(`update tickets set visit_date = visit_date - 1 where id='${y.id}'`);
    assert.equal((await hook(phone(), c2)).json.linkExpired, true, 'an earlier day');
  });

  it('calling the ticket sends "your turn" to the linked number only', async () => {
    const a = newTicket('WA-010'), b = newTicket('WA-011');
    const { p: pa } = await connected(a); const { p: pb } = await connected(b);
    const r = await api('POST', `/api/tenant/tickets/${a.id}/call`, { token: tenantToken, body: { roomLabel: 'Room 4' } });
    assert.equal(r.status, 200, r.text);
    const m = await waitFor(async () => sent(pa).find((x) => /your turn/i.test(x.body)));
    assert.ok(m && /Room 4/.test(m.body));
    assert.equal(sent(pb).filter((x) => /your turn/i.test(x.body)).length, 0);
  });

  it('"you\'re next" goes once to whoever is first in line after a call', async () => {
    sql(`update tickets set status='cancelled' where tenant_id='${tid}' and status='waiting'`);
    const a = newTicket('WA-020'); await sleep(20); const b = newTicket('WA-021'); await sleep(20); const c = newTicket('WA-022');
    const { p: pb } = await connected(b); const { p: pc } = await connected(c);
    await api('POST', `/api/tenant/tickets/${a.id}/call`, { token: tenantToken, body: { roomLabel: 'Room 1' } });
    const m = await waitFor(async () => sent(pb).find((x) => /you're next/i.test(x.body)));
    assert.ok(m && /WA-021/.test(m.body));
    assert.equal(sent(pc).filter((x) => /you're next/i.test(x.body)).length, 0, 'third in line is not told');
    await api('POST', `/api/tenant/tickets/${a.id}/call-again`, { token: tenantToken, body: { roomLabel: 'Room 1' } });
    await sleep(400); assert.equal(sent(pb).filter((x) => /you're next/i.test(x.body)).length, 1, 'not repeated');
    await api('POST', `/api/tenant/tickets/${b.id}/call`, { token: tenantToken, body: { roomLabel: 'Room 2' } });
    const m2 = await waitFor(async () => sent(pc).find((x) => /you're next/i.test(x.body)));
    assert.ok(m2 && /WA-022/.test(m2.body), 'now the next person is told');
  });

  it('STOP deletes the number straight away, confirms, and leaves the place in the queue', async () => {
    const t = newTicket('WA-030'); const { p } = await connected(t);
    sql(`insert into whatsapp_sessions (phone_number, tenant_id, location_id) values ('${p}','${tid}','${locId}')`);
    const r = await hook(p, ' stop. '); assert.equal(r.json.stopped, true);
    assert.equal(linkRow(t).phone_number, null);
    assert.equal(sql(`select count(*) from whatsapp_sessions where phone_number='${p}'`), '0');
    assert.ok(await waitFor(async () => sent(p).find((x) => /stopped/i.test(x.body))));
    assert.equal((await view(t)).json.state, 'waiting');
    assert.equal((await view(t)).json.whatsappConnected, false);
  });

  it('numbers are deleted when a visit ends, kept for a no-show, and always gone after the day or 24 hours', async () => {
    const mk = async (num, opts) => { const t = newTicket(num, opts); const c = await connected(t); return { ...t, ...c }; };
    const waiting = await mk('WA-040'), done = await mk('WA-041'), seen = await mk('WA-042'), gone = await mk('WA-043'), noshow = await mk('WA-044'), old = await mk('WA-045'), yday = await mk('WA-046');
    sql(`update tickets set status='completed' where id='${done.id}'`);
    sql(`update tickets set status='seen' where id='${seen.id}'`);
    sql(`update tickets set status='cancelled' where id='${gone.id}'`);
    sql(`update tickets set status='no_show' where id='${noshow.id}'`);
    sql(`update ticket_whatsapp_links set connected_at = now() - interval '25 hours' where ticket_id='${old.id}'`);
    sql(`update tickets set visit_date = visit_date - 1 where id='${yday.id}'`);
    await purge();
    const has = (t) => linkRow(t).phone_number !== null;
    assert.equal(has(waiting), true, 'waiting kept'); assert.equal(has(noshow), true, 'no-show kept until the end of the day');
    for (const [n, t] of [['completed', done], ['seen', seen], ['cancelled', gone], ['older than 24h', old], ['yesterday', yday]]) assert.equal(has(t), false, `${n} cleared`);
    // a no-show put back in the queue keeps working: the number was still there
    sql(`update tickets set status='waiting' where id='${noshow.id}'`);
    await api('POST', `/api/tenant/tickets/${noshow.id}/call`, { token: tenantToken, body: { roomLabel: 'Room 9' } });
    assert.ok(await waitFor(async () => sent(noshow.p).find((x) => /Room 9/.test(x.body))));
  });

  it('location-code sessions older than 24 hours are removed', async () => {
    const p = phone();
    sql(`insert into whatsapp_sessions (phone_number, tenant_id, location_id, updated_at) values ('${p}','${tid}','${locId}', now() - interval '25 hours')`);
    await purge(); assert.equal(sql(`select count(*) from whatsapp_sessions where phone_number='${p}'`), '0');
  });

  it('nothing patient-level is stored besides the number: the link row has only code, number and times', () => {
    const cols = sql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='ticket_whatsapp_links'`);
    assert.equal(cols, 'connected_at,created_at,link_code,next_notified_at,phone_number,ticket_id,tenant_id'.split(',').sort().join(','));
  });
});
