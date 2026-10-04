import { query } from "../db/pool.js";

// Deleting a tenant is permanent — it cascades away their locations, services, licenses and
// audit log. Their revenue history isn't allowed to disappear from our books just because the
// account was removed, so we snapshot an anonymised summary (no name, email or address — just
// the business name and the figures) into deleted_tenant_revenue first. Used by both the
// system-admin "Delete customer" action and the tenant's own self-service "Delete account".
export async function snapshotAndDeleteTenant(tenantId) {
  const tenant = (await query(`select * from tenants where id=$1`, [tenantId])).rows[0];
  if (!tenant) return false;

  const licenses = (await query(
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
  const pendingRevenue = tenant.status === "pending" ? totalRevenue : 0;

  await query(
    `insert into deleted_tenant_revenue
       (original_tenant_id, business_name, signed_up_at, total_revenue, pending_revenue, license_count, location_count, revenue_by_plan)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenant.id, tenant.business_name, tenant.created_at,
      tenant.status === "pending" ? 0 : totalRevenue, pendingRevenue,
      licenses.length, tenant.location_count || 0, JSON.stringify(revenueByPlan),
    ]
  );

  await query(`delete from tenants where id=$1`, [tenant.id]);
  return true;
}
