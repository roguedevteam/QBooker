const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.reason = data.reason;
    err.data = data;
    throw err;
  }
  return data;
}

async function requestOrNetwork(path, opts) {
  // fetch() itself rejects (TypeError) when the network is down; mark that so callers can tell
  // "can't reach the server" (keep retrying) from "server said no" (err.status set).
  try { return await request(path, opts); }
  catch (err) { if (err.status == null) err.network = true; throw err; }
}

export const api = {
  getClock: () => request("/api/public/time"),

  getInfo: (tenantId) => request(`/api/public/tenant/${tenantId}/info`),
  getLocations: (tenantId) => request(`/api/public/tenant/${tenantId}/locations`),
  getServices: (tenantId) => request(`/api/public/tenant/${tenantId}/services`),
  getAvailability: (tenantId, serviceId, date, clockMinutes) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/availability?date=${date}&clockMinutes=${clockMinutes}`),
  createTicket: (tenantId, serviceId, payload) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/tickets`, { method: "POST", body: payload }),
  getTicketStatus: (tenantId, ticketId) => request(`/api/public/tenant/${tenantId}/tickets/${ticketId}/status`),
  getCodeInfo: (code) => request(`/api/public/code/${encodeURIComponent(code)}`),
  // Login-free ticket access: the unguessable token in the URL is the only credential.
  getPublicTicket: (token) => requestOrNetwork(`/api/public/ticket/${encodeURIComponent(token)}`),
  leavePublicTicket: (token) => requestOrNetwork(`/api/public/ticket/${encodeURIComponent(token)}/leave`, { method: "POST" }),
  checkInPublic: (token) => requestOrNetwork(`/api/public/ticket/${encodeURIComponent(token)}/check-in`, { method: "POST" }),
  whatsappIntent: (token) => requestOrNetwork(`/api/public/ticket/${encodeURIComponent(token)}/whatsapp-intent`, { method: "POST" }),
  checkIn: (tenantId, ticketId) => request(`/api/public/tenant/${tenantId}/tickets/${ticketId}/check-in`, { method: "POST" }),
  cancelTicket: (tenantId, ticketId) => request(`/api/public/tenant/${tenantId}/tickets/${ticketId}/cancel`, { method: "POST" }),
};
