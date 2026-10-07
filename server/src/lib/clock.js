// A runtime-adjustable "today", for testing date-locking behaviour without waiting for
// real time to pass. Defaults to the real date. Only System Admin can change it.
let override = null; // 'YYYY-MM-DD' or null

export function getToday() {
  return override || new Date().toISOString().slice(0, 10);
}
export function isSimulated() {
  return override !== null;
}
export function setSimulatedToday(dateStr) {
  override = dateStr;
}
export function clearSimulatedToday() {
  override = null;
}

// Minutes since midnight in the UK, used when a client doesn't say what time it is.
export function londonNowMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
}
