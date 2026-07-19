const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

let token = localStorage.getItem("qf_staff_token") || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("qf_staff_token", t);
  else localStorage.removeItem("qf_staff_token");
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

  requestStaffOtp: (accessCode) => request("/api/auth/staff/request-otp", { method: "POST", body: { accessCode }, auth: false }),
  verifyStaffOtp: (accessCode, code) => request("/api/auth/staff/verify-otp", { method: "POST", body: { accessCode, code }, auth: false }),

  me: () => request("/api/tenant/me"),
  getLocations: () => request("/api/tenant/locations"),
  getServices: () => request("/api/tenant/services"),
  getTickets: (date) => request(`/api/tenant/tickets?date=${date}`),

  callNext: (serviceId, payload) => request(`/api/tenant/services/${serviceId}/call-next`, { method: "POST", body: payload }),
  callAgain: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/call-again`, { method: "POST", body: payload }),
  returnToQueue: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/return-to-queue`, { method: "POST", body: payload }),
  cancelTicket: (ticketId) => request(`/api/tenant/tickets/${ticketId}/cancel`, { method: "POST" }),
  routeTicket: (ticketId, payload) => request(`/api/tenant/tickets/${ticketId}/route`, { method: "POST", body: payload }),
  closeTicket: (ticketId) => request(`/api/tenant/tickets/${ticketId}/close`, { method: "POST" }),
};
