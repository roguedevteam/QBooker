import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();

router.get("/:code", asyncHandler(async (req, res) => {
  const result = await query(
    `select lc.code, lc.tenant_id, lc.location_id, t.business_name, l.name as location_name
     from location_codes lc
     join tenants t on t.id = lc.tenant_id
     join locations l on l.id = lc.location_id
     where lc.code = $1`,
    [req.params.code.toUpperCase()]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "That code wasn't recognised." });
  const row = result.rows[0];
  res.json({ tenantId: row.tenant_id, locationId: row.location_id, businessName: row.business_name, locationName: row.location_name });
}));

export default router;
