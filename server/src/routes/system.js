import { Router } from "express";
import { resetRateLimits } from "../lib/rateLimit.js";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getToday, isSimulated, setSimulatedToday, clearSimulatedToday, nowSql, now as clockNow, testClockEnabled, setTestNow, clearTestNow, isTestClockActive } from "../lib/clock.js";
import { resolveServiceLicenses, resolveServiceLicense, resolvePlan, planPricing, effectivePricing } from "../lib/serviceLicense.js";
import { snapshotAndDeleteTenant } from "../lib/tenantDeletion.js";
import {
  badRequest, uuidParams, reqDate, optString, optEmail, optInt, optBool, optEnum, EMAIL_RE,
} from "../lib/validate.js";

const router = Router();
uuidParams(router, "id", "staffId", "svcId", "locId", "licenseId");
// Everything here is platform-wide, sensitive and changes under the admin's hands: never cached.
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff"); next(); });
router.use(requireAuth("system_admin"));

const audit = (tenantId, message) => query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [tenantId, message]);

router.get("/tenants", asyncHandler(async (req, res) => {
  const result = await query(
    `select t.*,
       coalesce(sl.service_count, 0) as service_count,
       coalesce(sl.total_spend, 0) as total_spend,
       coalesce(sl.unpaid_count, 0) as unpaid_count
     from tenants t
     left join (
       select tenant_id, count(distinct service_id) as service_count, sum(price) as total_spend,
         count(*) filter (where paid = false) as unpaid_count
       from service_licenses where status != 'refunded' group by tenant_id
     ) sl on sl.tenant_id = t.id
     order by t.created_at desc`
  );
  res.json({ tenants: result.rows });
}));

router.patch("/tenants/:id/staff/:staffId", asyncHandler(async (req, res) => {
  const first = optString(req.body.firstName, "First name", { max: 100 });
  const last = optString(req.body.lastName, "Last name", { max: 100 });
  const email = optString(req.body.email, "Email", { max: 254 });
  if (email !== undefined) {
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const dup = await query(`select 1 from staff_members where lower(email)=lower($1) and id<>$2`, [email, req.params.staffId]);
    if (dup.rows.length) return res.status(409).json({ error: "That email address is already registered to a staff member." });
  }
  const r = await query(
    `update staff_members set first_name=coalesce($1,first_name), last_name=coalesce($2,last_name), email=coalesce($3,email)
     where id=$4 and tenant_id=$5 returning id, first_name, last_name, email, created_at`,
    [first || null, last || null, email || null, req.params.staffId, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Staff member not found." });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.params.id, `Staff user updated by platform admin: ${r.rows[0].first_name} ${r.rows[0].last_name}`]);
  res.json({ staff: r.rows[0] });
}));
router.delete("/tenants/:id/staff/:staffId", asyncHandler(async (req, res) => {
  const r = await query(`delete from staff_members where id=$1 and tenant_id=$2 returning first_name, last_name`, [req.params.staffId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Staff member not found." });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.params.id, `Staff user removed by platform admin: ${r.rows[0].first_name} ${r.rows[0].last_name}`]);
  res.json({ ok: true });
}));

const TENANT_FIELD_LABELS = { business_name: "business name", first_name: "first name", last_name: "last name", email: "email", company_address: "address", location_count: "location count" };

router.patch("/tenants/:id", asyncHandler(async (req, res) => {
  const businessName = optString(req.body.businessName, "Business name");
  const firstName = optString(req.body.firstName, "First name", { max: 100 });
  const lastName = optString(req.body.lastName, "Last name", { max: 100 });
  const email = optEmail(req.body.email);
  const companyAddress = optString(req.body.companyAddress, "Company address", { max: 500, allowEmpty: true });
  const locationCount = optInt(req.body.locationCount, "locationCount", { min: 0, max: 100000 });
  const status = optEnum(req.body.status, "status", ["pending", "active", "disabled"]);
  const prev = (await query(`select * from tenants where id=$1`, [req.params.id])).rows[0];
  if (!prev) return res.status(404).json({ error: "Customer not found." });
  const result = await query(
    `update tenants set
       business_name = coalesce($1, business_name),
       first_name = coalesce($2, first_name),
       last_name = coalesce($3, last_name),
       email = coalesce($4, email),
       company_address = coalesce($5, company_address),
       location_count = coalesce($6, location_count),
       status = coalesce($7, status)
     where id=$8 returning *`,
    [businessName, firstName, lastName, email, companyAddress, locationCount, status, req.params.id]
  );
  const cur = result.rows[0];
  if (!cur) return res.status(404).json({ error: "Customer not found." });
  // Every real change leaves a trace the customer can see in their own activity log.
  if (status !== undefined && status !== prev.status) {
    if (status === "active") {
      await audit(cur.id, prev.status === "pending"
        ? "Invoice payment confirmed by our team — staff kiosk and customer WhatsApp are now enabled."
        : "Account re-enabled by our team — sign-in is allowed again.");
    } else if (status === "disabled") {
      await audit(cur.id, "Account disabled by our team — sign-in is blocked until it's re-enabled.");
    } else {
      await audit(cur.id, "Account set to payment pending by our team.");
    }
  }
  const changed = Object.keys(TENANT_FIELD_LABELS).filter((k) => String(cur[k] ?? "") !== String(prev[k] ?? "")).map((k) => TENANT_FIELD_LABELS[k]);
  if (changed.length) await audit(cur.id, `Account details updated by platform admin (${changed.join(", ")})`);
  res.json({ tenant: cur });
}));

// A service's type (queue/appointment/hybrid) and slot length can only be changed once it's
// never actually gone live — i.e. every license it's ever had is still just "available"
// (never assigned dates) and no calendar day has ever had hours set on it. Once a single day
// has hours, or a license has been scheduled/active/expired, changing the type would silently
// invalidate real bookings/queue history, so it's locked for good (same as the "can't be
// changed after this step" rule when the service was first created).
async function isServiceModeLocked(serviceId) {
  const configRows = await query(`select 1 from service_daily_config where service_id=$1 limit 1`, [serviceId]);
  if (configRows.rows.length > 0) return true;
  const licenses = await resolveServiceLicenses(serviceId);
  return licenses.some((l) => l.status !== "available" && l.status !== "refunded");
}

// Full drill-down for one customer — their locations, services, and every license across
// all of them (freshly resolved, so a window that's just expired/gone-active shows the
// right status) — backs the "view customer" detail screen.
router.get("/tenants/:id/detail", asyncHandler(async (req, res) => {
  const tenant = (await query(`select * from tenants where id=$1`, [req.params.id])).rows[0];
  if (!tenant) return res.status(404).json({ error: "Customer not found." });

  const locations = (await query(
    `select l.*, lc.code from locations l
     left join location_codes lc on lc.location_id = l.id
     where l.tenant_id=$1 order by l.created_at`,
    [tenant.id]
  )).rows;
  const rawServices = (await query(`select * from services where tenant_id=$1 order by created_at`, [tenant.id])).rows;

  let licenses = [];
  const services = [];
  for (const s of rawServices) {
    const resolved = await resolveServiceLicenses(s.id);
    licenses = licenses.concat(resolved.map((l) => ({ ...l, service_name: s.name })));
    const configRows = await query(`select 1 from service_daily_config where service_id=$1 limit 1`, [s.id]);
    const modeLocked = configRows.rows.length > 0 || resolved.some((l) => l.status !== "available" && l.status !== "refunded");
    services.push({ ...s, modeLocked });
  }
  licenses.sort((a, b) => new Date(b.purchased_at) - new Date(a.purchased_at));

  const staff = (await query(`select id, first_name, last_name, email, created_at from staff_members where tenant_id=$1 order by lower(first_name), lower(last_name)`, [req.params.id])).rows;
  res.json({ tenant, locations, services, licenses, staff });
}));

router.patch("/tenants/:id/locations/:locId", asyncHandler(async (req, res) => {
  const name = optString(req.body.name, "Name");
  const address = optString(req.body.address, "Address", { max: 500, allowEmpty: true });
  const result = await query(
    `update locations set name=coalesce($1,name), address=coalesce($2,address) where id=$3 and tenant_id=$4 returning *`,
    [name, address, req.params.locId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Location not found." });
  if (name !== undefined || address !== undefined) await audit(req.params.id, `Location "${result.rows[0].name}" updated by platform admin`);
  res.json({ location: result.rows[0] });
}));

router.delete("/tenants/:id/locations/:locId", asyncHandler(async (req, res) => {
  const r = await query(`delete from locations where id=$1 and tenant_id=$2 returning name`, [req.params.locId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Location not found." });
  // Keep the account's location count (shown in billing and summed in Reports) in step.
  await query(`update tenants set location_count = greatest(location_count - 1, 0) where id=$1`, [req.params.id]);
  await audit(req.params.id, `Location "${r.rows[0].name}" deleted by platform admin (its services and licenses went with it)`);
  res.json({ ok: true });
}));

// Keep in sync with the slot-length options customer-admin's own UI offers — a support
// override that saved something outside this set (e.g. "2 min") would show up as a slot
// length a tenant could never have picked themselves.
const isWholePence = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const VALID_SLOT_MINUTES = [5, 10, 15, 30, 60];

router.patch("/tenants/:id/services/:svcId", asyncHandler(async (req, res) => {
  const name = optString(req.body.name, "Name");
  const mode = optEnum(req.body.mode, "mode", ["queue", "appointment", "hybrid"]);
  const slotMinutes = optInt(req.body.slotMinutes, "slotMinutes", { min: 1, max: 1440, loose: true });
  const archived = optBool(req.body.archived, "archived");
  if (slotMinutes !== undefined && !VALID_SLOT_MINUTES.includes(Number(slotMinutes))) {
    return res.status(400).json({ error: `Slot length must be one of: ${VALID_SLOT_MINUTES.join(", ")} minutes.` });
  }
  if (mode !== undefined || slotMinutes !== undefined) {
    const existing = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Service not found." });
    if ((mode !== undefined && mode !== existing.mode) || (slotMinutes !== undefined && slotMinutes !== existing.slot_minutes)) {
      if (await isServiceModeLocked(req.params.svcId)) {
        return res.status(409).json({ error: "This service's type/slot length can't change — it has a license that's been scheduled, active or expired, or a day with hours already set." });
      }
    }
  }
  const result = await query(
    `update services set
       name = coalesce($1, name), mode = coalesce($2, mode),
       slot_minutes = coalesce($3, slot_minutes), archived = coalesce($4, archived)
     where id=$5 and tenant_id=$6 returning *`,
    [name, mode, slotMinutes, archived, req.params.svcId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Service not found." });
  if ([name, mode, slotMinutes, archived].some((v) => v !== undefined)) await audit(req.params.id, `Service "${result.rows[0].name}" updated by platform admin`);
  res.json({ service: result.rows[0] });
}));

router.delete("/tenants/:id/services/:svcId", asyncHandler(async (req, res) => {
  const r = await query(`delete from services where id=$1 and tenant_id=$2 returning name`, [req.params.svcId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Service not found." });
  await audit(req.params.id, `Service "${r.rows[0].name}" deleted by platform admin (its licenses went with it)`);
  res.json({ ok: true });
}));

// Platform-granted comp license — price 0, otherwise behaves exactly like a bought one
// (available -> can be scheduled from the customer's own service panel). Label is tagged
// so it's obviously a grant, not a real purchase, wherever licenses are listed.
// Annual licenses are price-on-application: platform admin sets the agreed price. Added as an
// invoice license (unpaid until marked paid), otherwise identical to any other license.
router.post("/tenants/:id/services/:svcId/licenses/annual", asyncHandler(async (req, res) => {
  // A number, or a plain decimal string ("1500", "1500.50") — not hex/exponent/padded forms — worth
  // between 1p and £1,000,000 and expressible in whole pence (it is charged exactly as entered).
  const rawPrice = req.body.price;
  const price = typeof rawPrice === "number" ? rawPrice : (typeof rawPrice === "string" && /^\d{1,9}(\.\d{1,10})?$/.test(rawPrice) ? Number(rawPrice) : NaN);
  if (!(price > 0) || price > 1000000) return res.status(400).json({ error: "Enter the agreed annual price." });
  if (!isWholePence(price)) return res.status(400).json({ error: "The annual price can have at most 2 decimal places (whole pence)." });
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  const result = await query(
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status, payment_method, paid, purchased_at)
     values ($1,$2,'year','Year (agreed price)',365,$3,'available','invoice',false,${nowSql()}) returning *`,
    [req.params.id, service.id, price.toFixed(2)]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.params.id, `Annual license added by platform admin for "${service.name}" at agreed price £${price.toFixed(2)}`]);
  res.json({ license: { ...result.rows[0], service_name: service.name } });
}));

router.post("/tenants/:id/services/:svcId/licenses/free", asyncHandler(async (req, res) => {
  const { planId, customDays } = req.body;
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });

  const pricingRow = (await query(`select value from platform_settings where key='plan_prices'`)).rows[0];
  const plan = resolvePlan(planId, customDays, planPricing(pricingRow));
  if (!plan) return res.status(400).json({ error: "Unknown plan type." });

  const result = await query(
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status, purchased_at)
     values ($1,$2,$3,$4,$5,0,'available',${nowSql()}) returning *`,
    [req.params.id, service.id, plan.planId, `${plan.planLabel} (free — granted)`, plan.planDays]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.params.id, `Free license granted by platform admin for "${service.name}" — ${plan.planLabel} (${plan.planDays} days)`]);
  res.json({ license: { ...result.rows[0], service_name: service.name } });
}));

// Support/admin refund — looser than the customer-facing one (no 90-day window, since this
// is a deliberate override), but still only for a license that's never actually gone live:
// Available (never scheduled) or Scheduled (dates assigned, but today hasn't reached them
// yet, so nothing was ever actually served against it). Active or Expired means it's already
// been "live" — those can't be refunded from here.
// Invoice (or pay-later) licenses stay unpaid until marked paid here. Once an account that was
// held as "pending" has nothing left unpaid, it goes active — same effect the old account-level
// "Mark paid" had.
router.post("/tenants/:id/licenses/:licenseId/mark-paid", asyncHandler(async (req, res) => {
  const cur = (await query(`select * from service_licenses where id=$1 and tenant_id=$2`, [req.params.licenseId, req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: "License not found." });
  // Already paid: nothing to do (a double click or retry must not move paid_at or log a second payment).
  if (cur.paid && cur.status !== "refunded") return res.json({ license: cur, activated: false });
  if (cur.status === "refunded") {
    return res.status(409).json({ error: "This license has been refunded, so it can't be marked as paid." });
  }
  if (cur.payment_method === "later") {
    return res.status(409).json({ error: "This is a pay-later license — it stays unpaid until the customer pays by card or chooses invoice." });
  }
  const result = await query(
    `update service_licenses set paid=true, paid_at=${nowSql()} where id=$1 and tenant_id=$2 and paid=false and status != 'refunded' returning *`,
    [req.params.licenseId, req.params.id]
  );
  if (!result.rows[0]) {
    // Lost a race with another request (paid or refunded a moment ago): report what is true now.
    const now = (await query(`select * from service_licenses where id=$1`, [req.params.licenseId])).rows[0];
    if (now?.paid && now.status !== "refunded") return res.json({ license: now, activated: false });
    return res.status(409).json({ error: "This license has just been refunded, so it can't be marked as paid." });
  }
  const lic = result.rows[0];
  const remaining = (await query(`select count(*)::int c from service_licenses where tenant_id=$1 and paid=false and status != 'refunded'`, [req.params.id])).rows[0].c;
  let activated = false;
  if (remaining === 0) {
    const u = await query(`update tenants set status='active' where id=$1 and status='pending' returning id`, [req.params.id]);
    activated = u.rows.length > 0;
  }
  await audit(req.params.id, `Payment confirmed for ${lic.plan_label} license (£${lic.price})${activated ? " — account activated" : ""}`);
  res.json({ license: lic, activated });
}));

router.post("/tenants/:id/services/:svcId/licenses/:licenseId/refund", asyncHandler(async (req, res) => {
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== service.id) return res.status(404).json({ error: "License not found." });
  if (license.payment_method === "later" && license.paid === false) {
    return res.status(409).json({ error: "Pay-later license that hasn't been paid — nothing to refund." });
  }
  if (license.status !== "available" && license.status !== "scheduled") {
    return res.status(409).json({ error: "Only a license that's never gone live (Available or Scheduled) can be refunded — this one is Active, Expired or already Refunded." });
  }

  const result = await query(
    `update service_licenses set status='refunded', refunded_at=${nowSql()} where id=$1 and status in ('available','scheduled') returning *`,
    [license.id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "This license has just changed state (refunded or gone live) — reload and check it." });
  if (license.status === "scheduled" && license.start_date && license.end_date) {
    await query(`delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
      [service.id, license.start_date, license.end_date]);
  }
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.params.id, `License refunded by platform admin for "${service.name}" — ${license.plan_label}`]);
  res.json({ license: { ...result.rows[0], service_name: service.name } });
}));

// Reports Overview below folds deleted_tenant_revenue snapshots back in, so totals don't
// drop just because a customer's account was deleted — see lib/tenantDeletion.js.
router.delete("/tenants/:id", asyncHandler(async (req, res) => {
  const ok = await snapshotAndDeleteTenant(req.params.id);
  if (!ok) return res.status(404).json({ error: "Customer not found." });
  res.json({ ok: true });
}));

async function storedPricing() {
  return effectivePricing((await query(`select value from platform_settings where key='plan_prices'`)).rows[0]?.value);
}

// What the console shows is exactly what customers see and are charged (built-in defaults fill in
// anything never saved).
router.get("/pricing", asyncHandler(async (req, res) => {
  res.json({ pricing: await storedPricing() });
}));

router.put("/pricing", asyncHandler(async (req, res) => {
  const price = (v, name) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1000000) throw badRequest(`${name} must be a number between 0 and 1,000,000.`);
    if (!isWholePence(v)) throw badRequest(`${name} can have at most 2 decimal places.`);
    return v;
  };
  const cur = await storedPricing();
  // Omitted prices keep their current value, so a partial update can never leave a plan without a price;
  // an explicit null is refused for the same reason.
  const next = {};
  for (const k of ["day", "week", "month", "year", "customDailyRate"]) {
    const v = req.body[k];
    if (v === undefined) next[k] = cur[k];
    else if (v === null) throw badRequest(`${k} can't be empty.`);
    else next[k] = price(v, k);
  }
  const { sale } = req.body;
  let cleanSale = sale === undefined ? cur.sale : { active: false };
  if (sale !== undefined && sale !== null) {
    if (typeof sale !== "object" || Array.isArray(sale)) throw badRequest("sale must be an object.");
    cleanSale = { active: optBool(sale.active, "sale.active") ?? false };
    for (const k of ["day", "week", "month", "year"]) {
      const v = sale[k];
      if (v === undefined) continue;
      cleanSale[k] = v === null ? null : price(v, `sale.${k}`);
      if (cleanSale[k] != null && cleanSale[k] > next[k]) throw badRequest(`The sale price for ${k} can't be higher than its regular price.`);
    }
  }
  // A saved sale price must never end up above its (possibly just lowered) regular price - customers would be charged more than list.
  for (const k of ["day", "week", "month", "year"]) {
    if (cleanSale[k] != null && cleanSale[k] > next[k]) throw badRequest(`The sale price for ${k} can't be higher than its regular price — lower or clear the sale price first.`);
  }
  const value = { ...next, sale: cleanSale };
  await query(
    `insert into platform_settings (key, value) values ('plan_prices', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)]
  );
  res.json({ pricing: value });
}));

// Revenue lives on service_licenses (one purchase per service), not on the tenant as a whole — a
// tenant's "pending" status (unconfirmed invoice) still gates whether its licenses are treated as
// billed. All sums are done in whole pence so the figures are exact (no 0.1 + 0.2 noise).
const pence = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
router.get("/reports/overview", asyncHandler(async (req, res) => {
  const counts = (await query(`select count(*)::int as customers, coalesce(sum(location_count),0)::bigint as locations from tenants`)).rows[0];
  const lic = (await query(
    `select l.plan_id, (t.status = 'pending') as pending, sum(l.price) as amount
     from service_licenses l join tenants t on t.id = l.tenant_id
     where l.status != 'refunded' group by l.plan_id, (t.status = 'pending')`
  )).rows;

  let totalP = 0;
  let pendingP = 0;
  const byPlanP = {};
  for (const r of lic) {
    const p = pence(r.amount);
    if (r.pending) pendingP += p;
    else { totalP += p; byPlanP[r.plan_id] = (byPlanP[r.plan_id] || 0) + p; }
  }

  // Fold in anonymised revenue snapshots from deleted customers so totals don't drop
  // just because an account was removed.
  const deletedRows = (await query(`select total_revenue, pending_revenue, revenue_by_plan from deleted_tenant_revenue`)).rows;
  let deletedP = 0;
  for (const row of deletedRows) {
    totalP += pence(row.total_revenue);
    pendingP += pence(row.pending_revenue);
    deletedP += pence(row.total_revenue);
    for (const [planId, amount] of Object.entries(row.revenue_by_plan || {})) {
      byPlanP[planId] = (byPlanP[planId] || 0) + pence(amount);
    }
  }

  const revenueByPlan = {};
  for (const [k, v] of Object.entries(byPlanP)) revenueByPlan[k] = v / 100;
  res.json({
    customerCount: counts.customers,
    totalRevenue: totalP / 100,
    pendingRevenue: pendingP / 100,
    totalLocations: Number(counts.locations),
    revenueByPlan,
    deletedCustomerCount: deletedRows.length,
    deletedRevenue: deletedP / 100,
  });
}));

// --- Simulated clock (testing only) ------------------------------------------
router.get("/clock", (req, res) => {
  res.json({ today: getToday(), simulated: isSimulated() });
});
router.post("/clock", (req, res) => {
  const { date } = req.body;
  if (date === undefined || date === null || date === "") return res.status(400).json({ error: "date required (YYYY-MM-DD)." });
  setSimulatedToday(reqDate(date, "date"));
  res.json({ today: getToday(), simulated: isSimulated() });
});
router.delete("/clock", (req, res) => {
  clearSimulatedToday();
  res.json({ today: getToday(), simulated: isSimulated() });
});

// --- Test clock (automated tests only) ---------------------------------------
// Moves the server's idea of "now" (date AND time of day). Exists only when NODE_ENV=test or QB_TEST_NOW
// is set; in any other deployment these routes answer 404 as if they did not exist.
router.use("/test-now", (req, res, next) => (testClockEnabled() ? next() : res.status(404).json({ error: "Not found." })));
router.get("/test-now", (req, res) => res.json({ now: clockNow().toISOString(), active: isTestClockActive(), today: getToday() }));
router.post("/test-now", (req, res) => {
  const { now, frozen } = req.body;
  if (typeof now !== "string") return res.status(400).json({ error: "now must be an ISO instant, e.g. 2026-10-24T23:30:00Z." });
  try { setTestNow(now, { frozen: frozen === true }); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ now: clockNow().toISOString(), active: isTestClockActive(), today: getToday() });
});
router.delete("/test-now", (req, res) => {
  clearTestNow();
  res.json({ now: clockNow().toISOString(), active: isTestClockActive(), today: getToday() });
});

// Test suites only: forget the per-IP rate-limit counters (one machine plays hundreds of patients).
router.post("/test-reset-limits", (req, res) => {
  if (!testClockEnabled()) return res.status(404).json({ error: "Not found." });
  resetRateLimits();
  res.json({ ok: true });
});

// Public (unauthenticated) pricing lookup, used by the signup screen.
export const publicRouter = Router();
publicRouter.get("/pricing", asyncHandler(async (req, res) => {
  res.json({ pricing: await storedPricing() });
}));
// Public read-only clock, so the marketing/web/admin apps can all agree on "today"
// (which may be a simulated date set from System Admin for testing).
publicRouter.get("/clock", (req, res) => {
  res.json({ today: getToday(), simulated: isSimulated() });
});
// The same plus the server's current instant, so the apps agree with the server about "now" (a phone with a wrong
// clock or time zone, or a test clock) and can work out London's date and wall-clock minutes from it.
publicRouter.get("/time", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ today: getToday(), simulated: isSimulated(), now: clockNow().toISOString() });
});

export default router;
