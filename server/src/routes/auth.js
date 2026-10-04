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

const router = Router();

// --- Signup ---------------------------------------------------------------
// Four steps on the client: account details -> free locations -> services (each assigned
// to a location, with its own license) -> payment. Locations cost nothing and don't limit
// anything; what's bought here is one license per service.
router.post("/signup", asyncHandler(async (req, res) => {
  const {
    businessName, firstName, lastName, email, companyAddress,
    locations, services,
  } = req.body;

  if (!email || !businessName || !firstName || !lastName || !locations?.length || !services?.length) {
    return res.status(400).json({ error: "Missing required signup fields." });
  }
  if (locations.some((l) => !l?.name?.trim())) {
    return res.status(400).json({ error: "Every location needs a name." });
  }
  // Location names must be unique per customer — this is how staff and customers tell locations
  // apart, so two locations on the same account can't share one.
  const normalizedNames = locations.map((l) => l.name.trim().toLowerCase());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    return res.status(400).json({ error: "Location names must be unique." });
  }
  if (services.some((s) => !s?.name?.trim() || s.locationIndex == null)) {
    return res.status(400).json({ error: "Every service needs a name and a location." });
  }

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
    const code = genOtp();
    await query(`insert into admin_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`, [tenant.id, code]);
    const body = `Your QBooker admin sign-in code is ${code}.`;
    await logSimulatedMessage({ tenantId: tenant.id, channel: "email", toReference: email, body });
    return res.json({ alreadyExists: true, demoOtp: code, businessName: tenant.business_name });
  }

  // Every new account gets one free 2-day trial license, no card needed. It's issued as an
  // ordinary Available license (movable between services), so the admin picks the two days.
  const trialPlan = { planId: "trial", planLabel: "2-day free trial", planDays: 2, price: 0 };
  const resolvedServices = services;

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
        [tenant.id, locations[i].name.trim(), locations[i].address || "", staffAccessCode]
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
        [tenant.id, location.id, s.name.trim(), s.mode || "hybrid", s.slotMinutes || 15]
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
    const code = genOtp();
    await query(
      `insert into admin_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`,
      [tenant.id, code]
    );
    const body = `Your QBooker admin sign-in code is ${code}.`;
    await logSimulatedMessage({ tenantId: tenant.id, channel: "email", toReference: email, body });

    res.json({ tenant: sanitizeTenant(tenant), demoOtp: code });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Signup failed — check the server's DATABASE_URL and Supabase connection." });
  } finally {
    if (client) client.release();
  }
}));

// --- Tenant admin OTP login -------------------------------------------------
router.post("/admin/request-otp", asyncHandler(async (req, res) => {
  const { email } = req.body;
  const result = await query(`select * from tenants where lower(email) = lower($1)`, [email]);
  if (result.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
  const tenant = result.rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
  }
  const code = genOtp();
  await query(`insert into admin_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`, [tenant.id, code]);
  const body = `Your QBooker admin sign-in code is ${code}.`;
  await logSimulatedMessage({ tenantId: tenant.id, channel: "email", toReference: email, body });
  res.json({ demoOtp: code });
}));

router.post("/admin/verify-otp", asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  const tenantResult = await query(`select * from tenants where lower(email) = lower($1)`, [email]);
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: "No account found with that email." });
  const tenant = tenantResult.rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
  }
  const otpResult = await query(
    `select * from admin_otp where tenant_id=$1 and code=$2 and consumed=false and expires_at > now() order by created_at desc limit 1`,
    [tenant.id, code]
  );
  if (otpResult.rows.length === 0) return res.status(401).json({ error: "Incorrect or expired code." });
  await query(`update admin_otp set consumed=true where id=$1`, [otpResult.rows[0].id]);
  const token = signSession({ role: "tenant_admin", tenantId: tenant.id }, "30d");
  res.json({ token, tenant: sanitizeTenant(tenant) });
}));

// --- Staff OTP login ---------------------------------------------------------
router.post("/staff/request-otp", asyncHandler(async (req, res) => {
  const { accessCode } = req.body;
  const locResult = await query(`select * from locations where staff_access_code = $1`, [accessCode]);
  if (locResult.rows.length === 0) return res.status(404).json({ error: "That access code doesn't match any location." });
  const location = locResult.rows[0];
  const tenantCheck = await query(`select status from tenants where id=$1`, [location.tenant_id]);
  if (tenantCheck.rows[0]?.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact your manager." });
  }
  const code = genOtp();
  await query(`insert into staff_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`, [location.tenant_id, code]);
  const body = `Your QBooker staff sign-in code is ${code}.`;
  await logSimulatedMessage({ tenantId: location.tenant_id, channel: "email", toReference: "staff", body });
  res.json({ demoOtp: code });
}));

router.post("/staff/verify-otp", asyncHandler(async (req, res) => {
  const { accessCode, code } = req.body;
  const locResult = await query(`select * from locations where staff_access_code = $1`, [accessCode]);
  if (locResult.rows.length === 0) return res.status(404).json({ error: "That access code doesn't match any location." });
  const location = locResult.rows[0];
  const tenantResult = await query(`select * from tenants where id = $1`, [location.tenant_id]);
  const tenant = tenantResult.rows[0];
  if (tenant.status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact your manager." });
  }
  const otpResult = await query(
    `select * from staff_otp where tenant_id=$1 and code=$2 and consumed=false and expires_at > now() order by created_at desc limit 1`,
    [tenant.id, code]
  );
  if (otpResult.rows.length === 0) return res.status(401).json({ error: "Incorrect or expired code." });
  await query(`update staff_otp set consumed=true where id=$1`, [otpResult.rows[0].id]);
  const token = signSession({ role: "staff", tenantId: tenant.id, locationId: location.id }, "10h");
  res.json({ token, tenant: sanitizeTenant(tenant), location: { id: location.id, name: location.name } });
}));

// --- System admin login (real password, not simulated) -----------------------
router.post("/system/login", asyncHandler(async (req, res) => {
  const { password } = req.body;
  const hash = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
  if (!hash || !password || !bcrypt.compareSync(password, hash)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const token = signSession({ role: "system_admin" }, "8h");
  res.json({ token });
}));

export default router;
