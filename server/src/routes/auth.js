import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, pool } from "../db/pool.js";
import { signSession } from "../lib/auth.js";
import { genOtp, genAccessCode, logSimulatedMessage } from "../lib/simulate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";

const router = Router();

function nineToFiveHours() {
  const hours = [];
  for (let h = 540; h < 1020; h += 30) hours.push(h);
  return hours;
}

// --- Signup ---------------------------------------------------------------
router.post("/signup", asyncHandler(async (req, res) => {
  const {
    businessName, email, planId, planLabel, planDays,
    activeDate, weekStartDate, startDate, endDate,
    price, pricePerLocation, locationCount,
    paymentMethod, invoiceEmail, invoicePO,
    locationNames, locationAddresses,
  } = req.body;

  if (!email || !businessName || !planId || !locationNames?.length) {
    return res.status(400).json({ error: "Missing required signup fields." });
  }
  if (paymentMethod === "invoice" && !invoicePO?.trim()) {
    return res.status(400).json({ error: "A PO / reference number is required for invoice payment." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const accessCode = genAccessCode();
    const status = paymentMethod === "invoice" ? "pending" : "active";
    const tenantResult = await client.query(
      `insert into tenants
        (business_name, email, plan_id, plan_label, plan_days, active_date, week_start_date, start_date, end_date,
         price, price_per_location, location_count, access_code, payment_method, status, invoice_email, invoice_po)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       returning *`,
      [businessName, email, planId, planLabel, planDays, activeDate || null, weekStartDate || null, startDate || null, endDate || null,
        price, pricePerLocation, locationCount, accessCode, paymentMethod, status, invoiceEmail || null, invoicePO || null]
    );
    const tenant = tenantResult.rows[0];

    const locationRows = [];
    for (let i = 0; i < locationNames.length; i++) {
      const r = await client.query(
        `insert into locations
          (tenant_id, name, address, plan_id, plan_label, plan_days, active_date, week_start_date, start_date, end_date, license_price)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [tenant.id, locationNames[i] || `Location ${i + 1}`, locationAddresses?.[i] || "",
          planId, planLabel, planDays, activeDate || null, weekStartDate || null, startDate || null, endDate || null, pricePerLocation]
      );
      const code = await createLocationCode((sql, params) => client.query(sql, params), tenant.id, r.rows[0].id);
      locationRows.push({ ...r.rows[0], code });
    }

    await client.query(
      `insert into audit_log (tenant_id, message) values ($1,$2)`,
      [tenant.id, `Account activated for ${businessName} — plan: ${planLabel} × ${locationCount} location(s)`]
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

    res.json({ tenant, demoOtp: code });
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
  const otpResult = await query(
    `select * from admin_otp where tenant_id=$1 and code=$2 and consumed=false and expires_at > now() order by created_at desc limit 1`,
    [tenant.id, code]
  );
  if (otpResult.rows.length === 0) return res.status(401).json({ error: "Incorrect or expired code." });
  await query(`update admin_otp set consumed=true where id=$1`, [otpResult.rows[0].id]);
  const token = signSession({ role: "tenant_admin", tenantId: tenant.id }, "30d");
  res.json({ token, tenant });
}));

// --- Staff OTP login ---------------------------------------------------------
router.post("/staff/request-otp", asyncHandler(async (req, res) => {
  const { accessCode } = req.body;
  const result = await query(`select * from tenants where access_code = $1`, [accessCode]);
  if (result.rows.length === 0) return res.status(404).json({ error: "That access code doesn't match any account." });
  const tenant = result.rows[0];
  const code = genOtp();
  await query(`insert into staff_otp (tenant_id, code, expires_at) values ($1,$2, now() + interval '10 minutes')`, [tenant.id, code]);
  const body = `Your QBooker staff sign-in code is ${code}.`;
  await logSimulatedMessage({ tenantId: tenant.id, channel: "email", toReference: "staff", body });
  res.json({ demoOtp: code });
}));

router.post("/staff/verify-otp", asyncHandler(async (req, res) => {
  const { accessCode, code } = req.body;
  const tenantResult = await query(`select * from tenants where access_code = $1`, [accessCode]);
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: "That access code doesn't match any account." });
  const tenant = tenantResult.rows[0];
  const otpResult = await query(
    `select * from staff_otp where tenant_id=$1 and code=$2 and consumed=false and expires_at > now() order by created_at desc limit 1`,
    [tenant.id, code]
  );
  if (otpResult.rows.length === 0) return res.status(401).json({ error: "Incorrect or expired code." });
  await query(`update staff_otp set consumed=true where id=$1`, [otpResult.rows[0].id]);
  const token = signSession({ role: "staff", tenantId: tenant.id }, "10h");
  res.json({ token, tenant });
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
