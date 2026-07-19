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
