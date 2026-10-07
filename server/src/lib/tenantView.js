// Fields that live on the tenant row for system-admin use only — stripped before a tenant row
// ever reaches the tenant's own admin/staff surfaces (customer-admin, staff kiosk).
const ADMIN_ONLY_FIELDS = ["signup_country"];
// Billing details are for the account owner; a staff kiosk session never needs them.
const STAFF_HIDDEN_FIELDS = ["invoice_po", "invoice_email", "access_code", "payment_method"];

export function sanitizeTenant(tenant, role) {
  if (!tenant) return tenant;
  const copy = { ...tenant };
  for (const field of ADMIN_ONLY_FIELDS) delete copy[field];
  if (role === "staff") for (const field of STAFF_HIDDEN_FIELDS) delete copy[field];
  return copy;
}
