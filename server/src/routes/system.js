import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getToday, isSimulated, setSimulatedToday, clearSimulatedToday } from "../lib/clock.js";

const router = Router();
router.use(requireAuth("system_admin"));

router.get("/tenants", asyncHandler(async (req, res) => {
  const result = await query(`select * from tenants order by created_at desc`);
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

router.delete("/tenants/:id", asyncHandler(async (req, res) => {
  await query(`delete from tenants where id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

router.get("/pricing", asyncHandler(async (req, res) => {
  const result = await query(`select value from platform_settings where key='plan_prices'`);
  res.json({ pricing: result.rows[0]?.value || {} });
}));

router.put("/pricing", asyncHandler(async (req, res) => {
  const { day, week, month, year, customDailyRate } = req.body;
  const value = { day, week, month, year, customDailyRate };
  await query(
    `insert into platform_settings (key, value) values ('plan_prices', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)]
  );
  res.json({ pricing: value });
}));

router.get("/reports/overview", asyncHandler(async (req, res) => {
  const tenants = (await query(`select * from tenants`)).rows;
  const active = tenants.filter((t) => t.status === "active");
  const pending = tenants.filter((t) => t.status === "pending");
  const totalRevenue = active.reduce((sum, t) => sum + Number(t.price || 0), 0);
  const pendingRevenue = pending.reduce((sum, t) => sum + Number(t.price || 0), 0);
  const totalLocations = tenants.reduce((sum, t) => sum + (t.location_count || 0), 0);
  const revenueByPlan = {};
  active.forEach((t) => { revenueByPlan[t.plan_id] = (revenueByPlan[t.plan_id] || 0) + Number(t.price || 0); });
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
  res.json({ pricing: result.rows[0]?.value || { day: 25, week: 100, month: 200, year: 600, customDailyRate: 20 } });
}));
// Public read-only clock, so the marketing/web/admin apps can all agree on "today"
// (which may be a simulated date set from System Admin for testing).
publicRouter.get("/clock", (req, res) => {
  res.json({ today: getToday(), simulated: isSimulated() });
});

export default router;
