// Every read/write is wrapped: localStorage can throw (private mode, blocked site data) and the
// app must still work — you just lose "saved on this phone".
const memory = {};

export function storeGet(key) {
  try { const v = window.localStorage.getItem(key); return v == null ? (memory[key] ?? null) : v; }
  catch { return memory[key] ?? null; }
}
export function storeSet(key, value) {
  memory[key] = value;
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}
export function storeRemove(key) {
  delete memory[key];
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

const ticketKey = (tenantId) => `qbooker.ticket.${tenantId}`;
export const getSavedToken = (tenantId) => storeGet(ticketKey(tenantId));
export const saveToken = (tenantId, token) => storeSet(ticketKey(tenantId), token);
export const clearSavedToken = (tenantId) => storeRemove(ticketKey(tenantId));

// Reflect the ticket token in the address bar (?k=...) so the page can be bookmarked / reopened.
export function setUrlToken(token) {
  try {
    const u = new URL(window.location.href);
    if (token) u.searchParams.set("k", token); else u.searchParams.delete("k");
    window.history.replaceState(null, "", u.toString());
  } catch { /* ignore */ }
}
export function urlParam(name) {
  try { return new URLSearchParams(window.location.search).get(name) || ""; } catch { return ""; }
}

// Random per-browser id, sent so the server can limit simultaneous tickets per device.
// It is not an identity: clearing site data gives a new one (the per-IP limit still applies).
export function getDeviceId() {
  let id = storeGet("qbooker.device");
  if (!id) {
    try { id = crypto.randomUUID().replace(/-/g, ""); }
    catch { id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(""); }
    storeSet("qbooker.device", id);
  }
  return id;
}

export const alertPref = {
  get: () => storeGet("qbooker.alert") === "1",
  set: (on) => storeSet("qbooker.alert", on ? "1" : "0"),
};
