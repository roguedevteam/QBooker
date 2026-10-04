// Fields that live on the tenant row for system-admin use only — stripped before a tenant row
// ever reaches the tenant's own admin/staff surfaces (customer-admin, staff kiosk).
const ADMIN_ONLY_FIELDS = ["signup_country"];

export function sanitizeTenant(tenant) {
  if (!tenant) return tenant;
  const copy = { ...tenant };
  for (const field of ADMIN_ONLY_FIELDS) delete copy[field];
  return copy;
}
