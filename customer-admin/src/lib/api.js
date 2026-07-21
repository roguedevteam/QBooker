const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

let token = localStorage.getItem("qf_admin_token") || null;

export function setToken(role, t) {
  token = t;
  if (t) localStorage.setItem("qf_admin_token", t);
  else localStorage.removeItem("qf_admin_token");
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

  requestAdminOtp: (email) => request("/api/auth/admin/request-otp", { method: "POST", body: { email }, auth: false }),
  verifyAdminOtp: (email, code) => request("/api/auth/admin/verify-otp", { method: "POST", body: { email, code }, auth: false }),

  me: () => request("/api/tenant/me"),
  getPlan: () => request("/api/tenant/plan"),
  reschedulePlan: (payload) => request("/api/tenant/plan", { method: "PATCH", body: payload }),
  extendPlan: () => request("/api/tenant/plan/extend", { method: "POST" }),

  getLocations: () => request("/api/tenant/locations"),
  addLocation: (name) => request("/api/tenant/locations", { method: "POST", body: { name } }),
  updateLocation: (id, patch) => request(`/api/tenant/locations/${id}`, { method: "PATCH", body: patch }),
  deleteLocation: (id) => request(`/api/tenant/locations/${id}`, { method: "DELETE" }),

  getServices: () => request("/api/tenant/services"),
  addService: (name, locationId) => request("/api/tenant/services", { method: "POST", body: { name, locationId } }),
  updateService: (id, patch) => request(`/api/tenant/services/${id}`, { method: "PATCH", body: patch }),
  deleteService: (id) => request(`/api/tenant/services/${id}`, { method: "DELETE" }),

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
