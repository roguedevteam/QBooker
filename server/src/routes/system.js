import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getToday, isSimulated, setSimulatedToday, clearSimulatedToday } from "../lib/clock.js";
import { resolveServiceLicenses, resolvePlan, planPricing } from "../lib/serviceLicense.js";

const router = Router();
router.use(requireAuth("system_admin"));

router.get("/tenants", asyncHandler(async (req, res) => {
  const result = await query(
    `select t.*,
       coalesce(sl.service_count, 0) as service_count,
       coalesce(sl.total_spend, 0) as total_spend
     from tenants t
     left join (
       select tenant_id, count(distinct service_id) as service_count, sum(price) as total_spend
       from service_licenses where status != 'refunded' group by tenant_id
     ) sl on sl.tenant_id = t.id
     order by t.created_at desc`
  );
  res.json({ tenants: result.rows });
}));

router.patch("/tenants/:id", asyncHandler(async (req, res) => {
  const { businessName, email, locationCount, status } = req.body;
  const result = await query(
    `update tenants set
       business_name = coalesce($1, business_name),
       email = coalesce($2, email),
       location_count = coalesce($3, location_count),
       status = coalesce($4, status)
     where id=$5 returning *`,
    [businessName, email, locationCount, status, req.params.id]
  );
  if (status === "active") {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.params.id, "Invoice payment confirmed by our team — staff kiosk and customer WhatsApp are now enabled."]);
  }
  res.json({ tenant: result.rows[0] });
}));

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
  const services = (await query(`select * from services where tenant_id=$1 order by created_at`, [tenant.id])).rows;

  let licenses = [];
  for (const s of services) {
    const resolved = await resolveServiceLicenses(s.id);
    licenses = licenses.concat(resolved.map((l) => ({ ...l, service_name: s.name })));
  }
  licenses.sort((a, b) => new Date(b.purchased_at) - new Date(a.purchased_at));

  res.json({ tenant, locations, services, licenses });
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

router.patch("/tenants/:id/services/:svcId", asyncHandler(async (req, res) => {
  const { name, mode, slotMinutes, archived } = req.body;
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

router.delete("/tenants/:id", asyncHandler(async (req, res) => {
  await query(`delete from tenants where id=$1`, [req.params.id]);
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
  const totalLocations = tenants.reduce((sum, t) => sum + (t.location_count || 0), 0);
  res.json({
    customerCount: tenants.length,
    totalRevenue,
    pendingRevenue,
    totalLocations,
    revenueByPlan,
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
