// Sign-in codes: generated with crypto.randomInt (simulate.js), stored only as a keyed hash, compared in constant time.
import crypto from "crypto";

export function otpTtlMinutes() {
  const n = Number(process.env.OTP_TTL_MINUTES);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 10;
}

// HMAC-SHA256 keyed with OTP_PEPPER (falls back to JWT_SECRET), bound to who the code is for and what kind it is, so a hash
// copied from one row cannot be replayed against another account or against the staff table.
export function hashOtp(purpose, ownerId, code) {
  const key = process.env.OTP_PEPPER || process.env.JWT_SECRET || "";
  return crypto.createHmac("sha256", key).update(`${purpose}\n${ownerId}\n${String(code)}`).digest("hex");
}

export function otpMatches(storedHash, purpose, ownerId, code) {
  const candidate = Buffer.from(hashOtp(purpose, ownerId, code), "utf8");
  const stored = Buffer.from(String(storedHash || ""), "utf8");
  // Equal-length check first (timingSafeEqual throws otherwise); both sides are fixed-length hex hashes in normal use.
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}
