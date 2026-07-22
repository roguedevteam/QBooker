import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// By default node-postgres converts Postgres `date` columns into JS Date objects, which
// then serialize to full ISO timestamps ("2026-07-20T00:00:00.000Z") in API responses —
// not the plain "2026-07-20" strings the rest of this app assumes everywhere (date math,
// comparisons, the client's calendar logic). Keeping them as raw strings avoids that
// mismatch at the source instead of needing to work around it in every route.
// 1082 is the Postgres OID for the `date` type.
pg.types.setTypeParser(1082, (val) => val);

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set — the server will fail to connect to Postgres.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase's managed Postgres
});

export async function query(text, params) {
  return pool.query(text, params);
}
