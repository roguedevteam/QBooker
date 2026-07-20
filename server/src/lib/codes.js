// Short codes like QB-7F3K2A — one per location. Encoded into QR codes and wa.me links so
// a single shared WhatsApp number can tell which business + location a message belongs to.
export function genLocationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — avoids QR/manual-entry mixups
  let s = "QB-";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Generates a code and inserts it, retrying on the rare collision.
// queryFn should be either the shared `query` helper, or `client.query.bind(client)` if
// called inside a transaction (e.g. during signup, alongside creating the location itself).
export async function createLocationCode(queryFn, tenantId, locationId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genLocationCode();
    try {
      await queryFn(`insert into location_codes (code, tenant_id, location_id) values ($1,$2,$3)`, [code, tenantId, locationId]);
      return code;
    } catch (err) {
      if (err.code === "23505") continue; // unique_violation — try a new code
      throw err;
    }
  }
  throw new Error("Could not generate a unique location code after 5 attempts");
}
