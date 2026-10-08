// Small input-validation toolkit. Every helper throws an HttpError (a 4xx) instead of letting a
// wrongly-typed or hostile value travel on to the database, where it would surface as a 500.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const notFound = (message = "Not found.", extra) => new HttpError(404, message, extra);
export const conflict = (message, extra) => new HttpError(409, message, extra);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// Registers router.param handlers so a malformed id in the path is a 404 before any query runs.
export function uuidParams(router, ...names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (!isUuid(value)) return res.status(404).json({ error: "Not found." });
      next();
    });
  }
}

// Calendar dates are plain 'YYYY-MM-DD' strings, and must be a real date in a sane range.
export function isDateString(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function reqDate(v, name = "date") {
  if (!isDateString(v)) throw badRequest(`${name} must be a date in YYYY-MM-DD format.`);
  return v;
}
// undefined/null -> undefined; anything else must be a valid date.
export function optDate(v, name = "date") {
  if (v === undefined || v === null) return undefined;
  return reqDate(v, name);
}

function checkText(v, name, max) {
  if (typeof v !== "string") throw badRequest(`${name} must be text.`);
  if (v.includes("\u0000")) throw badRequest(`${name} contains characters that aren't allowed.`);
  if (v.length > max) throw badRequest(`${name} is too long (max ${max} characters).`);
}
// Required, non-blank text. Returns the trimmed value.
export function reqString(v, name, { max = 200 } = {}) {
  if (v === undefined || v === null) throw badRequest(`${name} is required.`);
  checkText(v, name, max);
  const s = v.trim();
  if (!s) throw badRequest(`${name} is required.`);
  return s;
}
// Optional text: undefined/null -> undefined (leave unchanged). Blank is allowed only with allowEmpty.
export function optString(v, name, { max = 200, allowEmpty = false } = {}) {
  if (v === undefined || v === null) return undefined;
  checkText(v, name, max);
  const s = v.trim();
  if (!s && !allowEmpty) throw badRequest(`${name} can't be blank.`);
  return s;
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function reqEmail(v, name = "email") {
  const s = reqString(v, name, { max: 254 });
  if (!EMAIL_RE.test(s)) throw badRequest("Enter a valid email address.");
  return s;
}
export function optEmail(v, name = "email") {
  if (v === undefined || v === null) return undefined;
  return reqEmail(v, name);
}

// Whole number within [min, max]. Accepts numbers only (not numeric strings) unless loose.
export function optInt(v, name, { min = 0, max = 1000000, loose = false } = {}) {
  if (v === undefined || v === null) return undefined;
  let n = v;
  if (loose && typeof v === "string" && /^-?\d{1,15}$/.test(v.trim())) n = Number(v);
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}
export function reqInt(v, name, opts) {
  const n = optInt(v, name, opts);
  if (n === undefined) throw badRequest(`${name} is required.`);
  return n;
}
export function optBool(v, name) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw badRequest(`${name} must be true or false.`);
  return v;
}
export function optEnum(v, name, allowed) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw badRequest(`${name} must be one of: ${allowed.join(", ")}.`);
  return v;
}
// Minutes since midnight as sent by a client's clock; lenient (numbers or numeric strings), or undefined.
export function clockMinutesOrUndefined(v) {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1439) return undefined;
  return Math.floor(v);
}
// Opening hours: array of 30-minute block starts (0..1410), unique, at most 48. Returned sorted.
export function parseHours(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 48) throw badRequest("hours must be a list of up to 48 half-hour start times.");
  for (const h of v) {
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 1410 || h % 30 !== 0) {
      throw badRequest("Each opening hour must be a half-hour start time between 00:00 and 23:30.");
    }
  }
  if (new Set(v).size !== v.length) throw badRequest("hours must not contain duplicates.");
  return [...v].sort((a, b) => a - b);
}

// A business website: only http(s) links are ever stored (a "javascript:" or "data:" URL rendered as a link would run
// script). A bare "example.org" gets https:// in front. undefined/null -> undefined; blank -> "" (clears it).
export function optWebUrl(v, name = "Website", { max = 300 } = {}) {
  const s = optString(v, name, { max, allowEmpty: true });
  if (s === undefined || s === "") return s;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { throw badRequest(`${name} must be a web address starting with http:// or https://.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest(`${name} must be a web address starting with http:// or https://.`);
  if (!u.hostname || u.username || u.password) throw badRequest(`${name} must be a web address starting with http:// or https://.`);
  return withScheme;
}
