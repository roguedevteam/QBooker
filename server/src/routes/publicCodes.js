import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { rateLimit } from "../lib/rateLimit.js";

const router = Router();

// A code names a business and location, so guessing them must be slow: 60 lookups a minute per connection
// (a patient scanning a QR poster needs one).
router.get("/:code", rateLimit({ windowMs: 60 * 1000, max: 60 }), asyncHandler(async (req, res) => {
  if (!/^[A-Za-z0-9-]{3,20}$/.test(req.params.code)) return res.status(404).json({ error: "That code wasn't recognised." });
  const result = await query(
    `select lc.code, lc.tenant_id, lc.location_id, t.business_name, l.name as location_name
     from location_codes lc
     join tenants t on t.id = lc.tenant_id
     join locations l on l.id = lc.location_id
     where lc.code = $1 and t.status <> 'disabled'`,
    [req.params.code.toUpperCase()]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "That code wasn't recognised." });
  const row = result.rows[0];
  res.json({ tenantId: row.tenant_id, locationId: row.location_id, businessName: row.business_name, locationName: row.location_name });
}));

export default router;
