const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

let token = localStorage.getItem("qb_sysadmin_token") || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("qb_sysadmin_token", t);
  else localStorage.removeItem("qb_sysadmin_token");
}
export function hasToken() {
  return !!token;
}

// Called when the server says the session is no longer valid (expired token, or a token that isn't a
// system-admin one), so the app can go back to the sign-in screen instead of sitting on a dead dashboard.
let sessionEnded = null;
export function onSessionEnded(cb) { sessionEnded = cb; }

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server — check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (auth && (res.status === 401 || res.status === 403)) {
      setToken(null);
      if (sessionEnded) sessionEnded("Your session has ended — please sign in again.");
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  login: (password) => request("/api/auth/system/login", { method: "POST", body: { password }, auth: false }),
  getTenants: () => request("/api/system/tenants"),
  updateTenant: (id, patch) => request(`/api/system/tenants/${id}`, { method: "PATCH", body: patch }),
  deleteTenant: (id) => request(`/api/system/tenants/${id}`, { method: "DELETE" }),
  getTenantDetail: (id) => request(`/api/system/tenants/${id}/detail`),
  updateTenantLocation: (id, locId, patch) => request(`/api/system/tenants/${id}/locations/${locId}`, { method: "PATCH", body: patch }),
  deleteTenantLocation: (id, locId) => request(`/api/system/tenants/${id}/locations/${locId}`, { method: "DELETE" }),
  updateTenantService: (id, svcId, patch) => request(`/api/system/tenants/${id}/services/${svcId}`, { method: "PATCH", body: patch }),
  deleteTenantService: (id, svcId) => request(`/api/system/tenants/${id}/services/${svcId}`, { method: "DELETE" }),
  grantFreeLicense: (id, svcId, body) => request(`/api/system/tenants/${id}/services/${svcId}/licenses/free`, { method: "POST", body }),
  addAnnualLicense: (id, svcId, body) => request(`/api/system/tenants/${id}/services/${svcId}/licenses/annual`, { method: "POST", body }),
  updateTenantStaff: (id, staffId, body) => request(`/api/system/tenants/${id}/staff/${staffId}`, { method: "PATCH", body }),
  deleteTenantStaff: (id, staffId) => request(`/api/system/tenants/${id}/staff/${staffId}`, { method: "DELETE" }),
  markLicensePaid: (id, licenseId) => request(`/api/system/tenants/${id}/licenses/${licenseId}/mark-paid`, { method: "POST" }),
  refundTenantLicense: (id, svcId, licenseId) => request(`/api/system/tenants/${id}/services/${svcId}/licenses/${licenseId}/refund`, { method: "POST" }),
  getPricing: () => request("/api/system/pricing"),
  putPricing: (payload) => request("/api/system/pricing", { method: "PUT", body: payload }),
  getReportsOverview: () => request("/api/system/reports/overview"),
  getClock: () => request("/api/system/clock"),
  setClock: (date) => request("/api/system/clock", { method: "POST", body: { date } }),
  resetClock: () => request("/api/system/clock", { method: "DELETE" }),
};
