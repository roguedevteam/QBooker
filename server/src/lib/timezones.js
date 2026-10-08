import { query } from "../db/pool.js";
import { badRequest } from "./validate.js";
import { isKnownTimezone, DEFAULT_TIMEZONE } from "./clock.js";

// Time zones are IANA names ("Europe/London", "America/New_York", "Asia/Kolkata"). They are checked three ways, because
// each side only works if all agree: the shape (a real region/city name, not a POSIX string like "EST5EDT" or an
// offset), Intl (Node computes dates and minutes with it) and the database's own list (the end-of-day sweep and the
// visit_date default use `at time zone`). The database's spelling wins, so "asia/kolkata" is stored as "Asia/Kolkata".
const NAME_RE = /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$/i;

// Returns the canonical zone name, or null if it is not an acceptable time zone.
export async function canonicalTimezone(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 64) return null;
  if (s.toUpperCase() === "UTC") return "UTC";
  if (!NAME_RE.test(s)) return null;
  const r = await query(`select name from pg_timezone_names where lower(name) = lower($1) limit 1`, [s]);
  const name = r.rows[0]?.name;
  return name && isKnownTimezone(name) ? name : null;
}

// undefined/null -> undefined (leave unchanged); anything else must be a usable zone, else a 400.
export async function optTimezone(v, name = "Time zone") {
  if (v === undefined || v === null) return undefined;
  const tz = await canonicalTimezone(v);
  if (!tz) throw badRequest(`${name} must be a valid time zone name such as Europe/London or America/New_York.`);
  return tz;
}

export { DEFAULT_TIMEZONE };
