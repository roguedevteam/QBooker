const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

// sessionStorage (not localStorage) — cleared automatically when the tab/window closes,
// so testers always land back on the sign-in screen for a new session instead of being
// silently logged back into whichever account was last used, while still surviving an
// ordinary reload/navigation within the same tab.
let token = sessionStorage.getItem("qf_admin_token") || null;

export function setToken(role, t) {
  token = t;
  if (t) sessionStorage.setItem("qf_admin_token", t);
  else sessionStorage.removeItem("qf_admin_token");
}
export function hasToken() {
  return !!token;
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  getClock: () => request("/api/public/clock", { auth: false }),
  publicPricing: () => request("/api/public/pricing", { auth: false }),

  requestAdminOtp: (email) => request("/api/auth/admin/request-otp", { method: "POST", body: { email }, auth: false }),
  verifyAdminOtp: (email, code) => request("/api/auth/admin/verify-otp", { method: "POST", body: { email, code }, auth: false }),

  me: () => request("/api/tenant/me"),
  updateMe: (patch) => request("/api/tenant/me", { method: "PATCH", body: patch }),
  getAllLicenses: () => request("/api/tenant/licenses"),
  dismissSetupTask: (task) => request("/api/tenant/setup/dismiss", { method: "POST", body: { task } }),
  deleteMyAccount: () => request("/api/tenant/me", { method: "DELETE" }),
  payNow: (payload) => request("/api/tenant/pay-now", { method: "POST", body: payload }),

  getLocations: () => request("/api/tenant/locations"),
  addLocation: (name, address) => request("/api/tenant/locations", { method: "POST", body: { name, address } }),
  updateLocation: (id, patch) => request(`/api/tenant/locations/${id}`, { method: "PATCH", body: patch }),
  archiveLocation: (id) => request(`/api/tenant/locations/${id}`, { method: "PATCH", body: { archived: true } }),
  unarchiveLocation: (id) => request(`/api/tenant/locations/${id}`, { method: "PATCH", body: { archived: false } }),

  getServices: (includeArchived) => request(`/api/tenant/services${includeArchived ? "?includeArchived=true" : ""}`),
  addService: (name, locationId) => request("/api/tenant/services", { method: "POST", body: { name, locationId } }),
  updateService: (id, patch) => request(`/api/tenant/services/${id}`, { method: "PATCH", body: patch }),

  getServiceLicenses: (serviceId) => request(`/api/tenant/services/${serviceId}/licenses`),
  buyServiceLicense: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/licenses`, { method: "POST", body: payload }),
  scheduleServiceLicense: (serviceId, licenseId, startDate) => request(`/api/tenant/services/${serviceId}/licenses/${licenseId}`, { method: "PATCH", body: { startDate } }),
  unscheduleServiceLicense: (serviceId, licenseId) => request(`/api/tenant/services/${serviceId}/licenses/${licenseId}`, { method: "PATCH", body: { unschedule: true } }),
  moveServiceLicense: (serviceId, licenseId, targetServiceId) => request(`/api/tenant/services/${serviceId}/licenses/${licenseId}/move`, { method: "POST", body: { targetServiceId } }),
  payServiceLicense: (serviceId, licenseId, payload) => request(`/api/tenant/services/${serviceId}/licenses/${licenseId}/pay`, { method: "POST", body: payload }),
  refundServiceLicense: (serviceId, licenseId) => request(`/api/tenant/services/${serviceId}/licenses/${licenseId}/refund`, { method: "POST" }),

  getDailyConfig: (serviceId, from, to) => request(`/api/tenant/services/${serviceId}/daily-config?from=${from}&to=${to}`),
  putDailyConfig: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/daily-config`, { method: "PUT", body: payload }),
  copyDailyConfig: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/daily-config/copy`, { method: "POST", body: payload }),
  clearAllDailyConfig: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/daily-config/clear-all`, { method: "POST", body: payload }),

  getTickets: (date) => request(`/api/tenant/tickets?date=${date}`),
  updateTicket: (id, patch) => request(`/api/tenant/tickets/${id}`, { method: "PATCH", body: patch }),
  deleteTicket: (id) => request(`/api/tenant/tickets/${id}`, { method: "DELETE" }),

  getAuditLog: () => request("/api/tenant/audit-log"),
  getDashboardStats: (date) => request(`/api/tenant/dashboard/stats?date=${date}`),
};
