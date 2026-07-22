const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  getClock: () => request("/api/public/clock"),

  getInfo: (tenantId) => request(`/api/public/tenant/${tenantId}/info`),
  getLocations: (tenantId) => request(`/api/public/tenant/${tenantId}/locations`),
  getServices: (tenantId) => request(`/api/public/tenant/${tenantId}/services`),
  getAvailability: (tenantId, serviceId, date, clockMinutes) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/availability?date=${date}&clockMinutes=${clockMinutes}`),
  createTicket: (tenantId, serviceId, payload) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/tickets`, { method: "POST", body: payload }),
  getTicketStatus: (tenantId, ticketId) => request(`/api/public/tenant/${tenantId}/tickets/${ticketId}/status`),
};
