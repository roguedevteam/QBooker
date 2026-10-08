import jwt from "jsonwebtoken";
import "dotenv/config";

const SECRET = process.env.JWT_SECRET;

export function signSession(payload, expiresIn = "12h") {
  return jwt.sign(payload, SECRET, { expiresIn, algorithm: "HS256" });
}

// --- Session lifetimes (configurable) -------------------------------------------------------------------------
// A session lasts ADMIN_SESSION_HOURS / STAFF_SESSION_HOURS from its last activity: the API hands back a fresh token
// (X-Session-Token response header) once half the lifetime is used up, and the apps swap it in. A kiosk in daily use
// therefore never expires mid-shift, an abandoned one expires within the lifetime, and SESSION_MAX_DAYS caps how long
// one sign-in can be extended in total.
const num = (name, dflt) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n > 0 ? n : dflt; };
export const sessionSeconds = (role) => Math.round((role === "staff" ? num("STAFF_SESSION_HOURS", 16) : num("ADMIN_SESSION_HOURS", 12)) * 3600);
export const sessionMaxSeconds = () => Math.round(num("SESSION_MAX_DAYS", 30) * 86400);
const nowSec = () => Math.floor(Date.now() / 1000);

// `tv` is the token_version of the account row at sign-in; `at` is when the person actually signed in (kept across refreshes).
export function issueTenantSession({ role, tenantId, staffId, tokenVersion, authTime }) {
  const at = authTime || nowSec();
  const seconds = Math.min(sessionSeconds(role), at + sessionMaxSeconds() - nowSec());
  const payload = { role, tenantId, ...(staffId ? { staffId } : {}), tv: tokenVersion || 0, at };
  return signSession(payload, Math.max(1, seconds));
}

// Used after the account rows are loaded: a token issued before "sign out everywhere" (or before the staff member was switched off)
// carries an older version number and is refused. Tokens without the claim count as version 0, the column's default.
export const tokenVersionOk = (auth, row) => (Number(auth.tv) || 0) === (Number(row?.token_version) || 0);

// Sets X-Session-Token when this session has used up half its lifetime (and may still be extended).
export function slideSession(req, res) {
  const a = req.auth;
  if (!a || !a.exp || !a.iat || (a.role !== "tenant_admin" && a.role !== "staff")) return;
  const life = sessionSeconds(a.role);
  const now = nowSec();
  const remaining = a.exp - now;
  if (remaining <= 0 || remaining > life / 2) return;
  const at = Number(a.at) || a.iat;
  if (at + sessionMaxSeconds() - now < 60) return; // at the hard cap: let it run out
  res.set("X-Session-Token", issueTenantSession({ role: a.role, tenantId: a.tenantId, staffId: a.staffId, tokenVersion: Number(a.tv) || 0, authTime: at }));
}

export function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in." });
    try {
      // Algorithm pinned: never trust the token header to choose how it is verified (alg:none / key confusion).
      const payload = jwt.verify(token, SECRET, { algorithms: ["HS256"] });
      if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Not allowed for this role." });
      }
      req.auth = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Session expired or invalid — please sign in again." });
    }
  };
}
