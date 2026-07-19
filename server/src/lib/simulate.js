import { query } from "../db/pool.js";

// Generates a 6-digit code. In production with real email/WhatsApp, you'd stop
// returning `code` to the caller and instead only deliver it via the provider.
export function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function genAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}`;
}

// Logs a message as if it were sent, and returns it so the caller can also
// hand it back to the frontend for on-screen display (simulated delivery).
export async function logSimulatedMessage({ tenantId, channel, toReference, body }) {
  await query(
    `insert into simulated_messages (tenant_id, channel, to_reference, body) values ($1, $2, $3, $4)`,
    [tenantId, channel, toReference, body]
  );
  return body;
}
