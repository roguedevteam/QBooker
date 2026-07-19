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
  login: (password) => request("/api/auth/system/login", { method: "POST", body: { password }, auth: false }),
  getTenants: () => request("/api/system/tenants"),
  updateTenant: (id, patch) => request(`/api/system/tenants/${id}`, { method: "PATCH", body: patch }),
  deleteTenant: (id) => request(`/api/system/tenants/${id}`, { method: "DELETE" }),
  getPricing: () => request("/api/system/pricing"),
  putPricing: (payload) => request("/api/system/pricing", { method: "PUT", body: payload }),
  getReportsOverview: () => request("/api/system/reports/overview"),
  getClock: () => request("/api/system/clock"),
  setClock: (date) => request("/api/system/clock", { method: "POST", body: { date } }),
  resetClock: () => request("/api/system/clock", { method: "DELETE" }),
};
