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

  // Resolves a QR/wa.me location code to its tenant + location — the real entry point.
  lookupCode: (code) => request(`/api/public/code/${encodeURIComponent(code)}`),

  getInfo: (tenantId) => request(`/api/public/tenant/${tenantId}/info`),
  getServices: (tenantId) => request(`/api/public/tenant/${tenantId}/services`),
  getAvailability: (tenantId, serviceId, date, clockMinutes) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/availability?date=${date}&clockMinutes=${clockMinutes}`),
  createTicket: (tenantId, serviceId, payload) =>
    request(`/api/public/tenant/${tenantId}/services/${serviceId}/tickets`, { method: "POST", body: payload }),
};
