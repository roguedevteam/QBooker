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

// Pool sizing for Railway (one or two API instances) -> Supabase pooler. Every value can be overridden from the
// environment, so tuning needs no code change:
//   DB_POOL_MAX            max connections held by THIS process (default 10). Keep instances x max under the pooler's
//                          client limit (Supabase Free/Pro pooler: 200 clients; direct connections: ~60 on small compute).
//   DB_POOL_IDLE_MS        close a connection idle this long (default 30000), so quiet periods hand slots back.
//   DB_CONNECT_TIMEOUT_MS  max wait for a free pooled connection OR for a new connection to open (default 5000). Without it a
//                          saturated pool queues requests forever; with it they fail fast (503, see index.js).
//   DB_QUERY_TIMEOUT_MS    client-side cap on any one query (default 20000).
//   DB_STATEMENT_TIMEOUT_MS / DB_IDLE_TX_TIMEOUT_MS  optional server-side caps sent as connection startup parameters
//                          (off by default: Supabase's transaction pooler on :6543 may reject startup parameters; the ticket
//                          transaction sets its own `set local` timeouts instead, which work through any pooler).
const num = (name, dflt) => { const n = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) && n >= 0 ? n : dflt; };
const optional = (name) => { const n = num(name, 0); return n > 0 ? { [name === "DB_STATEMENT_TIMEOUT_MS" ? "statement_timeout" : "idle_in_transaction_session_timeout"]: n } : {}; };

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }, // required for Supabase; tests use a local DB
  max: Math.max(1, num("DB_POOL_MAX", 10)),
  idleTimeoutMillis: num("DB_POOL_IDLE_MS", 30000),
  connectionTimeoutMillis: num("DB_CONNECT_TIMEOUT_MS", 5000),
  query_timeout: num("DB_QUERY_TIMEOUT_MS", 20000),
  keepAlive: true, // notice half-dead connections (pooler restarts, NAT timeouts) instead of waiting on them
  ...optional("DB_STATEMENT_TIMEOUT_MS"),
  ...optional("DB_IDLE_TX_TIMEOUT_MS"),
});

// A database restart/failover (Supabase maintenance, pooler redeploy, idle connections cut by a firewall) makes every
// connection emit an 'error' event. An 'error' event nobody listens to crashes Node, so listen: log (throttled) and let
// the pool discard the dead connection and open a fresh one on the next request.
let lastPoolLog = 0;
function logPoolError(err) {
  const now = Date.now();
  if (now - lastPoolLog < 5000) return;
  lastPoolLog = now;
  console.warn(`[db] connection error (pool will reconnect): ${err.code || ""} ${err.message}`);
}
pool.on("error", logPoolError);
// pg-pool only listens on idle connections; a connection that dies while checked out between two statements of a
// transaction would otherwise emit an unhandled 'error' too. This permanent listener covers that window.
pool.on("connect", (client) => client.on("error", logPoolError));

export async function query(text, params) {
  return pool.query(text, params);
}
