// Removes everything the load tests created (tenants named lt-*; children cascade). Optional: KEEP_HIST=1 keeps the lt-hist seed.
import { sql } from "./lib.mjs";
const like = process.env.KEEP_HIST === "1" ? `business_name like 'lt-%' and business_name not like 'lt-hist-%'` : `business_name like 'lt-%'`;
const r = await sql(`delete from tenants where ${like} returning 1`);
await sql(`delete from simulated_messages where tenant_id is null and to_reference like 'LT%'`);
console.log(`deleted ${r.length} load-test tenants`);
process.exit(0);
