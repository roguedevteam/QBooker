import crypto from "crypto";
import { query } from "../db/pool.js";

// Generates a 6-digit sign-in code (crypto.randomInt, so it is not guessable from earlier codes). Codes are delivered by
// lib/email.js and stored hashed (lib/otp.js); they are returned over HTTP only in test/demo mode (see demoOtpAllowed).
export function genOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

export function genAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 3 }, () => chars[crypto.randomInt(chars.length)]).join("");
  return `${part()}-${part()}`;
}

// Records a message in the simulated_messages log (used for the WhatsApp call pings, which have no phone number to
// deliver to yet). Never pass sign-in codes here: emails go through lib/email.js.
export async function logSimulatedMessage({ tenantId, channel, toReference, body }) {
  await query(
    `insert into simulated_messages (tenant_id, channel, to_reference, body) values ($1, $2, $3, $4)`,
    [tenantId, channel, toReference, body]
  );
  return body;
}
