export const BLOCK_MINUTES = 30;

export function formatTime(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

export function perStaffCapacity(slotMinutes) {
  return Math.max(1, Math.floor(BLOCK_MINUTES / slotMinutes));
}

// walkInStaffCount is now an explicit, independently-set value (not derived from
// staffCount - bookingStaffCount) — cfg.walkInStaffCount is expected on every caller, but
// this falls back to the old derived figure for any caller that hasn't been updated yet.
export function walkInBudget(cfg) {
  const walkInStaff = cfg.walkInStaffCount ?? Math.max(0, cfg.staffCount - cfg.bookingStaffCount);
  return Math.max(0, walkInStaff) * perStaffCapacity(cfg.slotMinutes);
}

export function bookableBudget(cfg) {
  return Math.max(0, Math.min(cfg.bookingStaffCount, cfg.staffCount)) * perStaffCapacity(cfg.slotMinutes);
}

// Rough wait estimate for a customer with `aheadCount` walk-ins in front of them — spreads
// them evenly over the walk-in capacity per 30-minute block. Returns null when there's no
// walk-in capacity at all (nothing meaningful to estimate).
export function estimateWalkInWaitMinutes(cfg, aheadCount) {
  const budget = walkInBudget(cfg);
  if (budget <= 0) return null;
  return Math.max(0, Math.round((aheadCount / budget) * BLOCK_MINUTES));
}

// cfg: { hours: number[], slotMinutes, staffCount, bookingStaffCount }  (hours = open block starts)
export function getHourBlocks(cfg) {
  return [...(cfg.hours || [])].sort((a, b) => a - b);
}

export function currentHourBlock(cfg, clockMinutes) {
  const blocks = getHourBlocks(cfg);
  const found = blocks.find((b) => clockMinutes >= b && clockMinutes < b + BLOCK_MINUTES);
  if (found !== undefined) return found;
  const future = blocks.find((b) => b > clockMinutes);
  return future !== undefined ? future : null;
}

export function walkInStatusNow(cfg, walkInCountInBlock, clockMinutes) {
  const block = currentHourBlock(cfg, clockMinutes);
  if (block === null) return { available: false, block: null };
  const budget = walkInBudget(cfg);
  if (budget <= 0) return { available: false, block };
  return { available: walkInCountInBlock < budget, remaining: Math.max(0, budget - walkInCountInBlock), block };
}

export function getBookableSlotsForHour(cfg, hourStart) {
  const perStaff = perStaffCapacity(cfg.slotMinutes);
  if (cfg.bookingStaffCount <= 0 || perStaff <= 0) return [];
  const spacing = Math.max(cfg.slotMinutes, Math.floor(BLOCK_MINUTES / perStaff));
  const slots = [];
  let t = hourStart;
  for (let i = 0; i < perStaff && t < hourStart + BLOCK_MINUTES; i++) {
    slots.push(t);
    t += spacing;
  }
  return slots;
}

// bookedCountByTime: { [slotTime]: count } of existing non-cancelled bookings today
export function getUpcomingBookableSlots(cfg, bookedCountByTime, fromMin, limit = 4) {
  const blocks = getHourBlocks(cfg);
  let slots = [];
  blocks.forEach((b) => { slots = slots.concat(getBookableSlotsForHour(cfg, b)); });
  return slots
    .filter((s) => s >= fromMin && (bookedCountByTime[s] || 0) < cfg.bookingStaffCount)
    .slice(0, limit);
}
