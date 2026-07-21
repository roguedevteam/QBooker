import { api } from "./api.js";

let cachedToday = new Date().toISOString().slice(0, 10);
let cachedSimulated = false;

// Synchronous — reads whatever was last fetched. Call refreshClock() first (App does this on load).
export function todayIso() {
  return cachedToday;
}
export function isSimulatedToday() {
  return cachedSimulated;
}
export async function refreshClock() {
  try {
    const r = await api.getClock();
    cachedToday = r.today;
    cachedSimulated = r.simulated;
  } catch {
    // Server unreachable — keep using the last known/fallback value.
  }
  return cachedToday;
}
