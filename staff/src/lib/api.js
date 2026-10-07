const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

let token = null;
try { token = localStorage.getItem("qf_staff_token") || null; } catch { /* storage unavailable */ }

export function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem("qf_staff_token", t);
    else localStorage.removeItem("qf_staff_token");
  } catch { /* storage unavailable: stay signed in for this tab only */ }
}
export function hasToken() {
  return !!token;
}

// Called when the server says our session is no longer valid (401: expired, removed or switched off;
// 403: the account was disabled), so the kiosk can return to the sign-in screen from any call or poll.
let authLostHandler = null;
export function setAuthLostHandler(fn) { authLostHandler = fn; }

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (auth && token && (res.status === 401 || res.status === 403)) authLostHandler?.(res.status);
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  getClock: () => request("/api/public/clock", { auth: false }),

  requestStaffOtp: (email) => request("/api/auth/staff/request-otp", { method: "POST", body: { email }, auth: false }),
  verifyStaffOtp: (email, code) => request("/api/auth/staff/verify-otp", { method: "POST", body: { email, code }, auth: false }),

  me: () => request("/api/tenant/me"),
  getLocations: () => request("/api/tenant/locations"),
  getServices: () => request("/api/tenant/services"),
  getTickets: (date) => request(`/api/tenant/tickets?date=${date}`),
  getToday: (serviceId, clockMinutes) => request(`/api/tenant/today?serviceId=${encodeURIComponent(serviceId)}${clockMinutes != null ? `&clockMinutes=${clockMinutes}` : ""}`),

  callNext: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/call-next`, { method: "POST", body: payload }),
  callTicket: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/call`, { method: "POST", body: payload }),
  callAgain: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/call-again`, { method: "POST", body: payload }),
  returnToQueue: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/return-to-queue`, { method: "POST", body: payload }),
  cancelTicket: (ticketId) => request(`/api/tenant/tickets/${ticketId}/cancel`, { method: "POST" }),
  noShowTicket: (ticketId) => request(`/api/tenant/tickets/${ticketId}/no-show`, { method: "POST" }),
  routeTicket: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/route`, { method: "POST", body: payload }),
  closeTicket: (ticketId) => request(`/api/tenant/tickets/${ticketId}/close`, { method: "POST" }),
};
