import { pool } from "../db/pool.js";

// Deleting a tenant is permanent — it cascades away their locations, services, licenses and
// audit log. Their revenue history isn't allowed to disappear from our books just because the
// account was removed, so we snapshot an anonymised summary (no name, email or address — just
// the business name and the figures) into deleted_tenant_revenue first. Used by both the
// system-admin "Delete customer" action and the tenant's own self-service "Delete account".
//
// Snapshot and delete happen in one transaction on a locked tenant row, so two simultaneous
// deletes (double click, retry) can't both record a snapshot: the second finds nothing and
// returns false.
export async function snapshotAndDeleteTenant(tenantId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query(`select * from tenants where id=$1 for update`, [tenantId])).rows[0];
    if (!tenant) {
      await client.query("ROLLBACK");
      return false;
    }

    const licenses = (await client.query(
      `select plan_id, price from service_licenses where tenant_id=$1 and status != 'refunded'`,
      [tenant.id]
    )).rows;
    let totalRevenue = 0;
    const revenueByPlan = {};
    for (const lic of licenses) {
      const price = Number(lic.price || 0);
      totalRevenue += price;
      revenueByPlan[lic.plan_id] = (revenueByPlan[lic.plan_id] || 0) + price;
    }
    const isPending = tenant.status === "pending";
    // Same rule as the live Reports Overview: an unconfirmed (pending) account's licences are
    // pending invoices, not revenue — they stay out of the confirmed total AND the by-plan split.
    await client.query(
      `insert into deleted_tenant_revenue
         (original_tenant_id, business_name, signed_up_at, total_revenue, pending_revenue, license_count, location_count, revenue_by_plan)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenant.id, tenant.business_name, tenant.created_at,
        isPending ? 0 : Math.round(totalRevenue * 100) / 100, isPending ? Math.round(totalRevenue * 100) / 100 : 0,
        licenses.length, tenant.location_count || 0,
        JSON.stringify(isPending ? {} : Object.fromEntries(Object.entries(revenueByPlan).map(([k, v]) => [k, Math.round(v * 100) / 100]))),
      ]
    );

    await client.query(`delete from tenants where id=$1`, [tenant.id]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
