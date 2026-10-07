import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, pool } from "../db/pool.js";
import { signSession } from "../lib/auth.js";
import { genOtp, genAccessCode, logSimulatedMessage } from "../lib/simulate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";
import { domainAcceptsMail } from "../lib/emailCheck.js";
import { countryForIp } from "../lib/geo.js";
import { sanitizeTenant } from "../lib/tenantView.js";
import { rateLimit } from "../lib/rateLimit.js";
import { badRequest, reqString, optString, reqEmail, optEnum, optInt } from "../lib/validate.js";

const router = Router();

// --- OTP request throttling -------------------------------------------------
// Each wrong guess burns one of an OTP's attempts, so the real brake on guessing is limiting how
// many fresh codes can be requested: per address, and per connection.
const OTP_WINDOW_MS = 10 * 60 * 1000;
const emailKey = (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "-");
const otpRequestLimits = [
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 12, message: "Too many sign-in code requests from this connection. Please wait a few minutes and try again." }),
  rateLimit({ windowMs: OTP_WINDOW_MS, max: 10, keyFn: emailKey, message: "Too many sign-in codes requested for this address. Please wait a few minutes and try again." }),
];
const MAX_OTP_ATTEMPTS = 5;

// Sign-in emails: must be text, but a malformed address is just "no account found".
function reqEmailLoose(v) {
  const email = reqString(v, "email", { max: 254 });
  return email;
}

// Issues an admin sign-in code for a tenant and logs the (simulated) email.
async function issueAdminOtp(tenant, email) {
  const code = genOtp();
  await query(`insert into admin_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`, [tenant.id, code]);
  await logSimulatedMessage({ tenantId: tenant.id, channel: "email", toReference: email, body: `Your QBooker admin sign-in code is ${code}.` });
  return code;
}

// --- Signup ---------------------------------------------------------------
// Four steps on the client: account details -> free locations -> services (each assigned
// to a location, with its own license) -> payment. Locations cost nothing and don't limit
// anything; what's bought here is one license per service.
router.post("/signup", asyncHandler(async (req, res) => {
  const businessName = reqString(req.body.businessName, "Business name");
  const firstName = reqString(req.body.firstName, "First name", { max: 100 });
  const lastName = reqString(req.body.lastName, "Last name", { max: 100 });
  const email = reqEmail(req.body.email);
  const companyAddress = optString(req.body.companyAddress, "Company address", { max: 500, allowEmpty: true });
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

  // Catches typos and made-up domains before we ever create an account against them — good
  // for deliverability on anything we send, and one less way for a junk account to appear.
  if (!(await domainAcceptsMail(email))) {
    return res.status(400).json({ error: "That email address doesn't look like it can receive mail — check for a typo." });
  }

  // One email = one account. If it already exists, don't create a duplicate — just send
  // them straight back to sign in, same as if they'd used the admin login screen directly.
  const existing = await query(`select * from tenants where lower(email) = lower($1)`, [email]);
  if (existing.rows.length > 0) {
    const tenant = existing.rows[0];
    if (tenant.status === "disabled") {
      return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
    }
    const code = await issueAdminOtp(tenant, email);
    return res.json({ alreadyExists: true, demoOtp: code, businessName: tenant.business_name });
  }

  // Every new account gets one free 2-day trial license, no card needed. It's issued as an
  // ordinary Available license (movable between services), so the admin picks the two days.
  const trialPlan = { planId: "trial", planLabel: "2-day free trial", planDays: 2, price: 0 };
  const resolvedServices = serviceDefs;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const accessCode = genAccessCode();
    // Trial accounts are fully active. Buying further licenses needs payment details first.
    const paymentMethod = "card"; // nothing is charged or stored at signup; payment is chosen when buying a license
    const status = "active";
    const signupCountry = countryForIp(req.ip);
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

    // Immediately issue an admin OTP so the frontend can go straight to verification, same as the prototype's flow.
    const code = await issueAdminOtp(tenant, email);

    res.json({ tenant: sanitizeTenant(tenant), demoOtp: code });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    // Deliberate 400s thrown inside the transaction pass straight through.
    if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ error: err.message });
    // A simultaneous signup with the same address won the race: behave as the "already exists" path.
    if (err.code === "23505" && /idx_tenants_email_unique/.test(err.constraint || "")) {
      const tenant = (await query(`select * from tenants where lower(email) = lower($1)`, [email])).rows[0];
      if (tenant && tenant.status !== "disabled") {
        const code = await issueAdminOtp(tenant, email);
        return res.json({ alreadyExists: true, demoOtp: code, businessName: tenant.business_name });
      }
    }
    console.error(err);
    res.status(500).json({ error: "Signup failed — check the server's DATABASE_URL and Supabase connection." });
  } finally {
    if (client) client.release();
  }
}));

// --- Tenant admin OTP login -------------------------------------------------
router.post("/admin/request-otp", ...otpRequestLimits, asyncHandler(async (req, res) => {
  const email = reqEmailLoose(req.body.email);
  const result = await query(`select * from tenants where lower(email) = lower($1)`, [email]);
  if (result.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
  const tenant = result.rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
  }
  const code = await issueAdminOtp(tenant, email);
  res.json({ demoOtp: code });
}));

router.post("/admin/verify-otp", asyncHandler(async (req, res) => {
  const email = reqEmailLoose(req.body.email);
  const code = typeof req.body.code === "string" ? req.body.code.trim().slice(0, 20) : "";
  const tenantResult = await query(`select * from tenants where lower(email) = lower($1)`, [email]);
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
  const tenant = tenantResult.rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
  }
  // Any unused, unexpired code that was emailed to this owner works (e.g. the one shown at sign-up
  // as well as a later "send login code"), but every wrong guess burns an attempt on all of them,
  // and a code that has used its attempts is dead. New codes are throttled (see otpRequestLimits).
  const active = (await query(
    `select * from admin_otp where tenant_id=$1 and consumed=false and expires_at > now() order by created_at desc`,
    [tenant.id]
  )).rows;
  const latest = active.find((o) => o.attempts < MAX_OTP_ATTEMPTS && o.code === code);
  if (!latest) {
    if (active.length) await query(`update admin_otp set attempts = attempts + 1 where id = any($1::uuid[])`, [active.map((o) => o.id)]);
    return res.status(401).json({ error: "Incorrect or expired code." });
  }
  const used = await query(`update admin_otp set consumed=true where id=$1 and consumed=false returning id`, [latest.id]);
  if (!used.rows[0]) return res.status(401).json({ error: "Incorrect or expired code." });
  const token = signSession({ role: "tenant_admin", tenantId: tenant.id }, "30d");
  res.json({ token, tenant: sanitizeTenant(tenant) });
}));

// --- Staff login: email + emailed code (staff are named users on the customer's staff list) ---
router.post("/staff/request-otp", ...otpRequestLimits, asyncHandler(async (req, res) => {
  const email = optString(req.body.email, "email", { max: 254, allowEmpty: true }) || "";
  const staff = email ? (await query(`select * from staff_members where lower(email)=lower($1)`, [email])).rows[0] : null;
  if (staff && staff.active) {
    const tenant = (await query(`select status from tenants where id=$1`, [staff.tenant_id])).rows[0];
    if (tenant?.status === "disabled") {
      return res.status(403).json({ error: "This account has been disabled — contact your manager." });
    }
    const code = genOtp();
    await query(`insert into staff_otp (tenant_id, staff_id, code, expires_at) values ($1,$2,$3, now() + interval '10 minutes')`, [staff.tenant_id, staff.id, code]);
    const body = `Your QBooker staff sign-in code is ${code}.`;
    await logSimulatedMessage({ tenantId: staff.tenant_id, channel: "email", toReference: staff.email, body });
    // Demo only: real email delivery isn't wired up yet, so the code is returned for testing.
    return res.json({ ok: true, demoOtp: code });
  }
  // Same response whether or not the address is registered, so it can't be used to find out who is.
  res.json({ ok: true });
}));

router.post("/staff/verify-otp", asyncHandler(async (req, res) => {
  const email = optString(req.body.email, "email", { max: 254, allowEmpty: true }) || "";
  const code = optString(req.body.code, "code", { max: 20, allowEmpty: true }) || "";
  const bad = () => res.status(401).json({ error: "Incorrect or expired code." });
  const staff = email ? (await query(`select * from staff_members where lower(email)=lower($1)`, [email])).rows[0] : null;
  if (!staff || !staff.active) return bad();
  const tenant = (await query(`select * from tenants where id=$1`, [staff.tenant_id])).rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact your manager." });
  }
  const latest = (await query(
    `select * from staff_otp where staff_id=$1 and consumed=false and expires_at > now() order by created_at desc limit 1`, [staff.id]
  )).rows[0];
  if (!latest || latest.attempts >= MAX_OTP_ATTEMPTS) return res.status(401).json({ error: "Incorrect or expired code — request a new one." });
  if (latest.code !== code) {
    await query(`update staff_otp set attempts = attempts + 1 where id=$1`, [latest.id]);
    return bad();
  }
  await query(`update staff_otp set consumed=true where id=$1`, [latest.id]);
  const token = signSession({ role: "staff", tenantId: tenant.id, staffId: staff.id }, "10h");
  res.json({ token, tenant: sanitizeTenant(tenant, "staff"), staff: { id: staff.id, firstName: staff.first_name, lastName: staff.last_name } });
}));

// --- System admin login (real password, not simulated) -----------------------
router.post("/system/login", asyncHandler(async (req, res) => {
  const { password } = req.body;
  const hash = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
  if (!hash || typeof password !== "string" || !password || password.length > 200 || !bcrypt.compareSync(password, hash)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const token = signSession({ role: "system_admin" }, "8h");
  res.json({ token });
}));

export default router;
