import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, pool } from "../db/pool.js";
import jwt from "jsonwebtoken";
import { signSession, issueTenantSession, requireAuth } from "../lib/auth.js";
import { genOtp, genAccessCode } from "../lib/simulate.js";
import { sendTemplatedEmail, emailStatus, demoOtpAllowed, createLatencyMirror, EmailError, SEND_FAILED_MESSAGE, NOT_CONFIGURED_MESSAGE } from "../lib/email.js";
import { hashOtp, otpMatches, otpTtlMinutes } from "../lib/otp.js";
import { resolveLang } from "../lib/i18n.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";
import { domainAcceptsMail } from "../lib/emailCheck.js";
import { countryForIp } from "../lib/geo.js";
import { sanitizeTenant } from "../lib/tenantView.js";
import { rateLimit, failureLimit, refundRateLimits } from "../lib/rateLimit.js";
import { badRequest, reqString, optString, reqEmail, optEnum, optInt } from "../lib/validate.js";

const router = Router();

// --- OTP request throttling -------------------------------------------------
// Each wrong guess burns one of an OTP's attempts, so the real brake on guessing is limiting how
// many fresh codes can be requested: per address, and per connection.
const OTP_WINDOW_MS = 10 * 60 * 1000;
// A body with no usable email isn't charged to one shared bucket (that would let junk requests lock everyone out); it counts against the connection.
const emailKey = (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : `ip:${req.ip}`);
const otpRequestLimits = [
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 12, message: "Too many sign-in code requests from this connection. Please wait a few minutes and try again." }),
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 10, keyFn: emailKey, message: "Too many sign-in codes requested for this address. Please wait a few minutes and try again." }),
];
// Sign-up emails the address owner too (a code, or "you already have an account"), so it is throttled the same way.
const signupLimits = [
  rateLimit({ windowMs: OTP_WINDOW_MS, max: Number(process.env.SIGNUP_IP_MAX) > 0 ? Number(process.env.SIGNUP_IP_MAX) : 30, message: "Too many sign-up attempts from this connection. Please wait a few minutes and try again." }),
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 10, keyFn: emailKey, message: "Too many sign-up attempts for this address. Please wait a few minutes and try again." }),
];
const MAX_OTP_ATTEMPTS = 5;

// Sign-in emails: must be text, but a malformed address is just "no account found".
function reqEmailLoose(v) {
  const email = reqString(v, "email", { max: 254 });
  return email;
}

// --- Email delivery plumbing ----------------------------------------------------------------------------------
// Nothing can be signed in if no code can be delivered, and handing codes out in the HTTP response instead is exactly the
// hole we must not open. So when email isn't configured these endpoints refuse (503) before doing any work or using any throttle budget.
function requireEmailReady(req, res, next) {
  if (emailStatus().ready) return next();
  res.set("Retry-After", "60");
  return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE });
}
const langOf = (req) => resolveLang(typeof req.body?.lang === "string" ? req.body.lang : req.headers["accept-language"]);
// "We couldn't send it": 503, and the attempt doesn't count against the caller's throttles.
function sendFailed(req, res) {
  refundRateLimits(req);
  res.set("Retry-After", "10");
  return res.status(503).json({ error: SEND_FAILED_MESSAGE });
}
const demoFields = (code) => (code && demoOtpAllowed() ? { demoOtp: code } : {});
// Known and unknown addresses must take about the same time: the unknown path sleeps for the recent average of the known one.
const adminMirror = createLatencyMirror();
const staffMirror = createLatencyMirror();
const signupMirror = createLatencyMirror();

// Issues an admin sign-in code (stored hashed; any earlier unused code is cancelled) and emails it. Returns the code.
async function issueAdminOtp(tenant, email, { lang, template = "otp" } = {}) {
  const code = genOtp();
  await query(
    `with cancelled as (update admin_otp set consumed=true where tenant_id=$1 and consumed=false)
     insert into admin_otp (tenant_id, code, expires_at) values ($1,$2, now() + make_interval(mins => $3))`,
    [tenant.id, hashOtp("admin", tenant.id, code), otpTtlMinutes()]
  );
  await sendTemplatedEmail({ to: email, template, lang, code, minutes: otpTtlMinutes(), tenantId: tenant.id });
  return code;
}
const sendDisabledNotice = (tenant, email, lang) => sendTemplatedEmail({ to: email, template: "disabled", lang, tenantId: tenant.id });


// Any unused, unexpired code that was emailed to this owner works, but every wrong guess burns an attempt on all of them,
// and a code that has used its attempts is dead. New codes are throttled (see otpRequestLimits) and cancel older ones.
async function consumeAdminOtp(tenant, code) {
  const active = (await query(
    `select * from admin_otp where tenant_id=$1 and consumed=false and expires_at > now() order by created_at desc`,
    [tenant.id]
  )).rows;
  const matches = active.map((o) => o.attempts < MAX_OTP_ATTEMPTS && otpMatches(o.code, "admin", tenant.id, code));
  const latest = active.find((o, i) => matches[i]);
  if (!latest) {
    if (active.length) await query(`update admin_otp set attempts = attempts + 1 where id = any($1::uuid[])`, [active.map((o) => o.id)]);
    return false;
  }
  const used = await query(`update admin_otp set consumed=true where id=$1 and consumed=false returning id`, [latest.id]);
  return !!used.rows[0];
}

// --- Signup ---------------------------------------------------------------
// The email address is verified FIRST, then the account is built:
//   1. POST /signup/request-code  { email }          -> a 6-digit code is emailed (always answers 200 { ok: true })
//   2. POST /signup/verify-code   { email, code }    -> { signupToken }, good for SIGNUP_TOKEN_MINUTES while the person fills in the rest
//   3. POST /signup               { signupToken, ...}-> creates the account and returns a short-lived hand-off token
//   4. POST /admin/exchange       { handoff }        -> the normal admin session (this is how the customer admin signs them straight in)
// Nothing is created until step 3, so an abandoned or mistyped sign-up leaves nothing behind. Later sign-ins use the usual emailed code.
// The setup itself is: account details -> free locations -> services (each assigned to a location, with its own license).
const SIGNUP_TOKEN_MINUTES = 90;
const signupVerifyLimits = [
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 30, message: "Too many attempts from this connection. Please wait a few minutes and try again." }),
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 15, keyFn: emailKey, message: "Too many attempts for this address. Please wait a few minutes and try again." }),
];

async function issueSignupOtp(email, lang) {
  const code = genOtp();
  const addr = email.toLowerCase();
  await query(
    `with cancelled as (update signup_otp set consumed=true where lower(email)=$1 and consumed=false)
     insert into signup_otp (email, code, expires_at) values ($1,$2, now() + make_interval(mins => $3))`,
    [addr, hashOtp("signup", addr, code), otpTtlMinutes()]
  );
  await sendTemplatedEmail({ to: email, template: "signup", lang, code, minutes: otpTtlMinutes() });
  return code;
}

// The short-lived "go straight in" token handed to the customer admin after sign-up or a verified existing address.
const HANDOFF_SECONDS = 120;
function handoffToken(tenant) {
  return signSession({ role: "signup_handoff", tenantId: tenant.id, tv: tenant.token_version || 0 }, HANDOFF_SECONDS);
}

router.post("/signup/request-code", requireEmailReady, ...signupLimits, asyncHandler(async (req, res) => {
  const lang = langOf(req);
  const email = reqEmail(req.body.email);
  // Catches typos and made-up domains before anything is sent (and keeps junk addresses out of our sender reputation).
  if (!(await domainAcceptsMail(email))) {
    return res.status(400).json({ error: "That email address doesn't look like it can receive mail — check for a typo." });
  }
  // Same answer whether or not the address already has an account: an existing owner gets a sign-in code instead (their email says so).
  const existing = (await query(`select * from tenants where lower(email) = lower($1)`, [email])).rows[0];
  try {
    if (existing) {
      await signupMirror.mimic();
      let code = null;
      if (existing.status === "disabled") await sendDisabledNotice(existing, existing.email, lang);
      else code = await issueAdminOtp(existing, existing.email, { lang, template: "exists" });
      return res.json({ ok: true, ...demoFields(code) });
    }
    const code = await signupMirror.track(() => issueSignupOtp(email, lang));
    return res.json({ ok: true, ...demoFields(code) });
  } catch (err) {
    if (err instanceof EmailError) return sendFailed(req, res);
    throw err;
  }
}));

router.post("/signup/verify-code", ...signupVerifyLimits, asyncHandler(async (req, res) => {
  const email = reqEmail(req.body.email);
  const code = typeof req.body.code === "string" ? req.body.code.trim().slice(0, 20) : "";
  const addr = email.toLowerCase();
  const bad = () => res.status(401).json({ error: GENERIC_BAD_CODE });

  // An address that already has an account is verified with the sign-in code it was emailed, and signed straight in.
  const existing = (await query(`select * from tenants where lower(email) = $1`, [addr])).rows[0];
  if (existing) {
    if (existing.status === "disabled") { otpMatches("0", "admin", "0", code); return bad(); }
    if (!(await consumeAdminOtp(existing, code))) return bad();
    return res.json({ existing: true, businessName: existing.business_name, handoff: handoffToken(existing) });
  }

  const active = (await query(
    `select * from signup_otp where lower(email)=$1 and consumed=false and expires_at > now() order by created_at desc`, [addr]
  )).rows;
  const matches = active.map((o) => o.attempts < MAX_OTP_ATTEMPTS && otpMatches(o.code, "signup", addr, code));
  const hit = active.find((o, i) => matches[i]);
  if (!hit) {
    if (active.length) await query(`update signup_otp set attempts = attempts + 1 where id = any($1::uuid[])`, [active.map((o) => o.id)]);
    else otpMatches("0", "signup", "0", code);
    return bad();
  }
  const used = await query(`update signup_otp set consumed=true where id=$1 and consumed=false returning id`, [hit.id]);
  if (!used.rows[0]) return bad();
  const signupToken = signSession({ role: "signup_verified", email: addr }, SIGNUP_TOKEN_MINUTES * 60);
  res.json({ signupToken, email });
}));

router.post("/signup", ...signupLimits, asyncHandler(async (req, res) => {
  const businessName = reqString(req.body.businessName, "Business name");
  const firstName = reqString(req.body.firstName, "First name", { max: 100 });
  const lastName = reqString(req.body.lastName, "Last name", { max: 100 });
  const companyAddress = optString(req.body.companyAddress, "Company address", { max: 500, allowEmpty: true });
  // The address comes from the verified token, never from the request body.
  let verifiedEmail;
  try {
    const tok = jwt.verify(typeof req.body.signupToken === "string" ? req.body.signupToken : "", process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (tok.role !== "signup_verified" || typeof tok.email !== "string") throw new Error("wrong token");
    verifiedEmail = tok.email;
  } catch {
    return res.status(401).json({ error: "Please confirm your email address first — your confirmation may have expired." });
  }
  const email = reqEmail(verifiedEmail);
  const { locations, services } = req.body;
  if (!Array.isArray(locations) || !Array.isArray(services) || !locations.length || !services.length) {
    return res.status(400).json({ error: "Missing required signup fields." });
  }
  if (locations.length > 100 || services.length > 200) throw badRequest("That's more locations or services than we can set up in one go.");
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!locations.every(isObj) || !services.every(isObj)) throw badRequest("Locations and services must each have a name.");
  const locationNames = locations.map((l) => {
    if (typeof l.name !== "string" || !l.name.trim()) throw badRequest("Every location needs a name.");
    optString(l.address, "Location address", { max: 500, allowEmpty: true });
    return reqString(l.name, "Location name");
  });
  // Location names must be unique per customer — this is how staff and customers tell locations
  // apart, so two locations on the same account can't share one.
  const normalizedNames = locationNames.map((n) => n.toLowerCase());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    return res.status(400).json({ error: "Location names must be unique." });
  }
  const serviceDefs = services.map((s) => {
    if (typeof s.name !== "string" || !s.name.trim() || s.locationIndex == null) throw badRequest("Every service needs a name and a location.");
    const locationIndex = optInt(s.locationIndex, "locationIndex", { min: 0, max: locations.length - 1 });
    return {
      name: reqString(s.name, "Service name"),
      locationIndex,
      mode: optEnum(s.mode, "mode", ["queue", "appointment", "hybrid"]) || "hybrid",
      slotMinutes: optInt(s.slotMinutes, "slotMinutes", { min: 1, max: 1440 }) || 15,
    };
  });

  // The address is verified, so it is safe to say so if an account already exists (e.g. they finished once already).
  const existing = await query(`select id from tenants where lower(email) = lower($1)`, [email]);
  if (existing.rows.length > 0) return res.status(409).json({ error: "An account already exists for this email address — sign in to the admin portal instead." });

  // Every new account gets one free 2-day trial license, no card needed. It's issued as an
  // ordinary Available license (movable between services), so the admin picks the two days.
  const trialPlan = { planId: "trial", planLabel: "2-day free trial", planDays: 2, price: 0 };
  const resolvedServices = serviceDefs;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const createStarted = Date.now();
    const accessCode = genAccessCode();
    // Trial accounts are fully active. Buying further licenses needs payment details first.
    const paymentMethod = "card"; // nothing is charged or stored at signup; payment is chosen when buying a license
    const status = "active";
    const signupCountry = await countryForIp(req.ip);
    const tenantResult = await client.query(
      `insert into tenants
        (business_name, email, location_count, access_code, payment_method, status, invoice_email, invoice_po,
         first_name, last_name, company_address, signup_country)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning *`,
      [businessName, email, locations.length, accessCode, paymentMethod, status, null, null,
        firstName, lastName, companyAddress || null, signupCountry]
    );
    const tenant = tenantResult.rows[0];

    // Locations are free and unlimited — just a routing/staff-access concept.
    const locationRows = [];
    for (let i = 0; i < locations.length; i++) {
      const staffAccessCode = genAccessCode();
      const r = await client.query(
        `insert into locations (tenant_id, name, address, staff_access_code) values ($1,$2,$3,$4) returning *`,
        [tenant.id, locationNames[i], (typeof locations[i].address === "string" ? locations[i].address.trim() : "") || "", staffAccessCode]
      );
      const code = await createLocationCode((sql, params) => client.query(sql, params), tenant.id, r.rows[0].id);
      locationRows.push({ ...r.rows[0], code });
    }

    // Each service is created against its location (fixed for good) and immediately gets
    // one Available license bound to it — not scheduled yet; the admin assigns dates from
    // the service's own calendar once they're in.
    let serviceIndex = 0;
    for (const s of resolvedServices) {
      const location = locationRows[s.locationIndex];
      if (!location) throw Object.assign(new Error("A service referenced a location that doesn't exist."), { statusCode: 400 });
      const svcResult = await client.query(
        `insert into services (tenant_id, location_id, name, mode, slot_minutes) values ($1,$2,$3,$4,$5) returning *`,
        [tenant.id, location.id, s.name, s.mode, s.slotMinutes]
      );
      if (serviceIndex === 0) {
        await client.query(
          `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status)
           values ($1,$2,$3,$4,$5,$6,'available')`,
          [tenant.id, svcResult.rows[0].id, trialPlan.planId, trialPlan.planLabel, trialPlan.planDays, trialPlan.price]
        );
      }
      serviceIndex++;
    }

    await client.query(
      `insert into audit_log (tenant_id, message) values ($1,$2)`,
      [tenant.id, `Account activated for ${businessName} — ${locations.length} location(s), ${services.length} service(s), 2-day free trial started`]
    );

    await client.query("COMMIT");
    signupMirror.record(Date.now() - createStarted);

    res.json({ ok: true, email, businessName, handoff: handoffToken(tenant), tenant: sanitizeTenant(tenant) });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    // Deliberate 400s thrown inside the transaction pass straight through.
    if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ error: err.message });
    // A simultaneous sign-up with the same address won the race.
    if (err.code === "23505" && /idx_tenants_email_unique/.test(err.constraint || "")) {
      return res.status(409).json({ error: "An account already exists for this email address — sign in to the admin portal instead." });
    }
    console.error(err);
    res.status(500).json({ error: "Signup failed — check the server's DATABASE_URL and Supabase connection." });
  } finally {
    if (client) client.release();
  }
}));

// --- Tenant admin OTP login -------------------------------------------------
// request-otp answers every address the same way (200 { ok: true }): it never says whether an account exists. The code, or a
// notice that the account is switched off, goes to the address's owner by email.
const GENERIC_BAD_CODE = "Incorrect or expired code.";
router.post("/admin/request-otp", requireEmailReady, ...otpRequestLimits, asyncHandler(async (req, res) => {
  const email = reqEmailLoose(req.body.email);
  const lang = langOf(req);
  const tenant = (await query(`select * from tenants where lower(email) = lower($1)`, [email])).rows[0];
  if (!tenant) {
    await adminMirror.mimic();
    return res.json({ ok: true });
  }
  try {
    // Always mail the address on file (not the spelling the visitor typed).
    const code = await adminMirror.track(async () => (tenant.status === "disabled" ? (await sendDisabledNotice(tenant, tenant.email, lang), null) : issueAdminOtp(tenant, tenant.email, { lang })));
    res.json({ ok: true, ...demoFields(code) });
  } catch (err) {
    if (err instanceof EmailError) return sendFailed(req, res);
    throw err;
  }
}));

router.post("/admin/verify-otp", asyncHandler(async (req, res) => {
  const email = reqEmailLoose(req.body.email);
  const code = typeof req.body.code === "string" ? req.body.code.trim().slice(0, 20) : "";
  const tenant = (await query(`select * from tenants where lower(email) = lower($1)`, [email])).rows[0];
  // Unknown address and switched-off account both look like a wrong code (and cost a similar amount of work).
  if (!tenant || tenant.status === "disabled") {
    otpMatches("0", "admin", "0", code);
    return res.status(401).json({ error: GENERIC_BAD_CODE });
  }
  if (!(await consumeAdminOtp(tenant, code))) return res.status(401).json({ error: GENERIC_BAD_CODE });
  const token = issueTenantSession({ role: "tenant_admin", tenantId: tenant.id, tokenVersion: tenant.token_version });
  res.json({ token, tenant: sanitizeTenant(tenant) });
}));

// Swaps the 2-minute hand-off token (from sign-up, or from verifying an existing address) for a normal admin session.
router.post("/admin/exchange", ...signupVerifyLimits, asyncHandler(async (req, res) => {
  let tok;
  try { tok = jwt.verify(typeof req.body.handoff === "string" ? req.body.handoff : "", process.env.JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return res.status(401).json({ error: "That link has expired — please sign in." }); }
  if (tok.role !== "signup_handoff") return res.status(401).json({ error: "That link has expired — please sign in." });
  const tenant = (await query(`select * from tenants where id=$1`, [tok.tenantId])).rows[0];
  if (!tenant || tenant.status === "disabled" || (Number(tok.tv) || 0) !== (Number(tenant.token_version) || 0)) {
    return res.status(401).json({ error: "That link has expired — please sign in." });
  }
  const token = issueTenantSession({ role: "tenant_admin", tenantId: tenant.id, tokenVersion: tenant.token_version });
  res.json({ token, tenant: sanitizeTenant(tenant) });
}));

// --- Staff login: email + emailed code (staff are named users on the customer's staff list) ---
// Same answer for a listed, an unlisted, a switched-off or a disabled-business address: 200 { ok: true }.
router.post("/staff/request-otp", requireEmailReady, ...otpRequestLimits, asyncHandler(async (req, res) => {
  const email = optString(req.body.email, "email", { max: 254, allowEmpty: true }) || "";
  const lang = langOf(req);
  const staff = email ? (await query(`select * from staff_members where lower(email)=lower($1)`, [email])).rows[0] : null;
  const tenant = staff && staff.active ? (await query(`select status from tenants where id=$1`, [staff.tenant_id])).rows[0] : null;
  if (!staff || !staff.active || !tenant || tenant.status === "disabled") {
    await staffMirror.mimic();
    return res.json({ ok: true });
  }
  try {
    const code = await staffMirror.track(async () => {
      const c = genOtp();
      await query(
        `with cancelled as (update staff_otp set consumed=true where staff_id=$2 and consumed=false)
         insert into staff_otp (tenant_id, staff_id, code, expires_at) values ($1,$2,$3, now() + make_interval(mins => $4))`,
        [staff.tenant_id, staff.id, hashOtp("staff", staff.id, c), otpTtlMinutes()]
      );
      await sendTemplatedEmail({ to: staff.email, template: "otp", lang, code: c, minutes: otpTtlMinutes(), tenantId: staff.tenant_id });
      return c;
    });
    res.json({ ok: true, ...demoFields(code) });
  } catch (err) {
    if (err instanceof EmailError) return sendFailed(req, res);
    throw err;
  }
}));

router.post("/staff/verify-otp", asyncHandler(async (req, res) => {
  const email = optString(req.body.email, "email", { max: 254, allowEmpty: true }) || "";
  const code = optString(req.body.code, "code", { max: 20, allowEmpty: true }) || "";
  const bad = () => res.status(401).json({ error: GENERIC_BAD_CODE });
  const staff = email ? (await query(`select * from staff_members where lower(email)=lower($1)`, [email])).rows[0] : null;
  const tenant = staff && staff.active ? (await query(`select * from tenants where id=$1`, [staff.tenant_id])).rows[0] : null;
  if (!staff || !staff.active || !tenant || tenant.status === "disabled") { otpMatches("0", "staff", "0", code); return bad(); }
  const latest = (await query(
    `select * from staff_otp where staff_id=$1 and consumed=false and expires_at > now() order by created_at desc limit 1`, [staff.id]
  )).rows[0];
  if (!latest || latest.attempts >= MAX_OTP_ATTEMPTS) { otpMatches("0", "staff", "0", code); return res.status(401).json({ error: "Incorrect or expired code — request a new one." }); }
  if (!otpMatches(latest.code, "staff", staff.id, code)) {
    await query(`update staff_otp set attempts = attempts + 1 where id=$1`, [latest.id]);
    return bad();
  }
  const used = await query(`update staff_otp set consumed=true where id=$1 and consumed=false returning id`, [latest.id]);
  if (!used.rows[0]) return bad();
  const token = issueTenantSession({ role: "staff", tenantId: tenant.id, staffId: staff.id, tokenVersion: staff.token_version });
  res.json({ token, tenant: sanitizeTenant(tenant, "staff"), staff: { id: staff.id, firstName: staff.first_name, lastName: staff.last_name } });
}));

// --- Sign out everywhere ---------------------------------------------------------------------------------------
// Session tokens carry the account's token_version; bumping it refuses every token issued before. An admin ends all their
// own sessions (optionally every staff member's too); a staff member ends their own; an admin can end one staff member's.
router.post("/sign-out-everywhere", requireAuth("tenant_admin", "staff"), asyncHandler(async (req, res) => {
  const { role, tenantId, staffId } = req.auth;
  if (role === "tenant_admin") {
    await query(`update tenants set token_version = token_version + 1 where id=$1`, [tenantId]);
    if (req.body.includeStaff === true) await query(`update staff_members set token_version = token_version + 1 where tenant_id=$1`, [tenantId]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenantId, req.body.includeStaff === true ? "Signed out of all admin and staff sessions" : "Signed out of all admin sessions"]);
  } else {
    await query(`update staff_members set token_version = token_version + 1 where id=$1 and tenant_id=$2`, [staffId, tenantId]);
  }
  res.json({ ok: true });
}));

router.post("/staff/:id/sign-out", requireAuth("tenant_admin"), asyncHandler(async (req, res) => {
  const r = await query(`update staff_members set token_version = token_version + 1 where id=$1 and tenant_id=$2 returning first_name, last_name`, [req.params.id, req.auth.tenantId]);
  if (!r.rows[0]) return res.status(404).json({ error: "Staff member not found." });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.auth.tenantId, `Signed ${r.rows[0].first_name} ${r.rows[0].last_name} out of all sessions`]);
  res.json({ ok: true });
}));

// --- System admin login (real password, not simulated) -----------------------
// The password is the only thing between the internet and the whole platform, so wrong guesses are
// throttled per client address: 10 failures in 10 minutes and that address gets 429 until the window
// passes (a correct sign-in clears the count). bcrypt runs async so a burst of guesses can't stall
// every other request on the server.
const systemLoginLimit = failureLimit({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many incorrect passwords from this connection. Please wait a few minutes and try again." });
const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff"); next(); };
router.post("/system/login", noStore, systemLoginLimit.guard, asyncHandler(async (req, res) => {
  const { password } = req.body;
  const hash = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
  const ok = !!hash && typeof password === "string" && password.length > 0 && password.length <= 200 && await bcrypt.compare(password, hash);
  if (!ok) {
    systemLoginLimit.fail(req);
    return res.status(401).json({ error: "Incorrect password." });
  }
  systemLoginLimit.clear(req);
  const token = signSession({ role: "system_admin" }, "8h");
  res.json({ token });
}));

export default router;
