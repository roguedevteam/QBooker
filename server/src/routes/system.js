import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getToday, isSimulated, setSimulatedToday, clearSimulatedToday } from "../lib/clock.js";
import { resolveServiceLicenses, resolveServiceLicense, resolvePlan, planPricing } from "../lib/serviceLicense.js";
import { snapshotAndDeleteTenant } from "../lib/tenantDeletion.js";

const router = Router();
router.use(requireAuth("system_admin"));

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
  const first = req.body.firstName?.trim(), last = req.body.lastName?.trim(), email = req.body.email?.trim();
  if (email !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
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

router.patch("/tenants/:id", asyncHandler(async (req, res) => {
  const { businessName, firstName, lastName, email, companyAddress, locationCount, status } = req.body;
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
  if (status === "active") {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.params.id, "Invoice payment confirmed by our team — staff kiosk and customer WhatsApp are now enabled."]);
  } else if (status === "disabled") {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.params.id, "Account disabled by our team — sign-in is blocked until it's re-enabled."]);
  }
  res.json({ tenant: result.rows[0] });
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
  const { name, address } = req.body;
  const result = await query(
    `update locations set name=coalesce($1,name), address=coalesce($2,address) where id=$3 and tenant_id=$4 returning *`,
    [name, address, req.params.locId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Location not found." });
  res.json({ location: result.rows[0] });
}));

router.delete("/tenants/:id/locations/:locId", asyncHandler(async (req, res) => {
  await query(`delete from locations where id=$1 and tenant_id=$2`, [req.params.locId, req.params.id]);
  res.json({ ok: true });
}));

// Keep in sync with the slot-length options customer-admin's own UI offers — a support
// override that saved something outside this set (e.g. "2 min") would show up as a slot
// length a tenant could never have picked themselves.
const VALID_SLOT_MINUTES = [5, 10, 15, 30, 60];

router.patch("/tenants/:id/services/:svcId", asyncHandler(async (req, res) => {
  const { name, mode, slotMinutes, archived } = req.body;
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
  res.json({ service: result.rows[0] });
}));

router.delete("/tenants/:id/services/:svcId", asyncHandler(async (req, res) => {
  await query(`delete from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id]);
  res.json({ ok: true });
}));

// Platform-granted comp license — price 0, otherwise behaves exactly like a bought one
// (available -> can be scheduled from the customer's own service panel). Label is tagged
// so it's obviously a grant, not a real purchase, wherever licenses are listed.
// Annual licenses are price-on-application: platform admin sets the agreed price. Added as an
// invoice license (unpaid until marked paid), otherwise identical to any other license.
router.post("/tenants/:id/services/:svcId/licenses/annual", asyncHandler(async (req, res) => {
  const price = Number(req.body.price);
  if (!(price > 0)) return res.status(400).json({ error: "Enter the agreed annual price." });
  const service = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.svcId, req.params.id])).rows[0];
  if (!service) return res.status(404).json({ error: "Service not found." });
  const result = await query(
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status, payment_method, paid)
     values ($1,$2,'year','Year (agreed price)',365,$3,'available','invoice',false) returning *`,
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
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status)
     values ($1,$2,$3,$4,$5,0,'available') returning *`,
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
  const cur = (await query(`select payment_method from service_licenses where id=$1 and tenant_id=$2`, [req.params.licenseId, req.params.id])).rows[0];
  if (cur?.payment_method === "later") {
    return res.status(409).json({ error: "This is a pay-later license — it stays unpaid until the customer pays by card or chooses invoice." });
  }
  const result = await query(
    `update service_licenses set paid=true, paid_at=now() where id=$1 and tenant_id=$2 returning *`,
    [req.params.licenseId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "License not found." });
  const lic = result.rows[0];
  const remaining = (await query(`select count(*)::int c from service_licenses where tenant_id=$1 and paid=false and status != 'refunded'`, [req.params.id])).rows[0].c;
  let activated = false;
  if (remaining === 0) {
    const u = await query(`update tenants set status='active' where id=$1 and status='pending' returning id`, [req.params.id]);
    activated = u.rows.length > 0;
  }
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.params.id, `Payment confirmed for ${lic.plan_label} license (£${lic.price})${activated ? " — account activated" : ""}`]);
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

  if (license.status === "scheduled" && license.start_date && license.end_date) {
    await query(`delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
      [service.id, license.start_date, license.end_date]);
  }
  const result = await query(
    `update service_licenses set status='refunded', refunded_at=now() where id=$1 returning *`,
    [license.id]
  );
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

router.get("/pricing", asyncHandler(async (req, res) => {
  const result = await query(`select value from platform_settings where key='plan_prices'`);
  res.json({ pricing: result.rows[0]?.value || { sale: { active: false } } });
}));

router.put("/pricing", asyncHandler(async (req, res) => {
  const { day, week, month, year, customDailyRate, sale } = req.body;
  const value = { day, week, month, year, customDailyRate, sale: sale || { active: false } };
  await query(
    `insert into platform_settings (key, value) values ('plan_prices', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)]
  );
  res.json({ pricing: value });
}));

// Revenue now lives on service_licenses (one purchase per service), not on the tenant
// as a whole — a tenant's "pending" status (unconfirmed invoice) still gates whether its
// licenses are treated as billed, same as it used to gate the old account-wide plan.
router.get("/reports/overview", asyncHandler(async (req, res) => {
  const tenants = (await query(`select * from tenants`)).rows;
  const pending = new Set(tenants.filter((t) => t.status === "pending").map((t) => t.id));
  const licenses = (await query(`select tenant_id, plan_id, price from service_licenses where status != 'refunded'`)).rows;

  let totalRevenue = 0;
  let pendingRevenue = 0;
  const revenueByPlan = {};
  for (const lic of licenses) {
    const price = Number(lic.price || 0);
    if (pending.has(lic.tenant_id)) {
      pendingRevenue += price;
    } else {
      totalRevenue += price;
      revenueByPlan[lic.plan_id] = (revenueByPlan[lic.plan_id] || 0) + price;
    }
  }

  // Fold in anonymised revenue snapshots from deleted customers so totals don't drop
  // just because an account was removed.
  const deletedRows = (await query(`select total_revenue, pending_revenue, revenue_by_plan from deleted_tenant_revenue`)).rows;
  let deletedRevenue = 0;
  for (const row of deletedRows) {
    totalRevenue += Number(row.total_revenue || 0);
    pendingRevenue += Number(row.pending_revenue || 0);
    deletedRevenue += Number(row.total_revenue || 0);
    for (const [planId, amount] of Object.entries(row.revenue_by_plan || {})) {
      revenueByPlan[planId] = (revenueByPlan[planId] || 0) + Number(amount || 0);
    }
  }

  const totalLocations = tenants.reduce((sum, t) => sum + (t.location_count || 0), 0);
  res.json({
    customerCount: tenants.length,
    totalRevenue,
    pendingRevenue,
    totalLocations,
    revenueByPlan,
    deletedCustomerCount: deletedRows.length,
    deletedRevenue,
  });
}));

// --- Simulated clock (testing only) ------------------------------------------
router.get("/clock", (req, res) => {
  res.json({ today: getToday(), simulated: isSimulated() });
});
router.post("/clock", (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: "date required (YYYY-MM-DD)." });
  setSimulatedToday(date);
  res.json({ today: getToday(), simulated: isSimulated() });
});
router.delete("/clock", (req, res) => {
  clearSimulatedToday();
  res.json({ today: getToday(), simulated: isSimulated() });
});

// Public (unauthenticated) pricing lookup, used by the signup screen.
export const publicRouter = Router();
publicRouter.get("/pricing", asyncHandler(async (req, res) => {
  const result = await query(`select value from platform_settings where key='plan_prices'`);
  res.json({ pricing: result.rows[0]?.value || { day: 25, week: 100, month: 200, year: 600, customDailyRate: 20, sale: { active: false } } });
}));
// Public read-only clock, so the marketing/web/admin apps can all agree on "today"
// (which may be a simulated date set from System Admin for testing).
publicRouter.get("/clock", (req, res) => {
  res.json({ today: getToday(), simulated: isSimulated() });
});

export default router;
