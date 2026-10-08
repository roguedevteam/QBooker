// Preloaded into the API under test (node --import ./loadtest/instrument.mjs src/index.js). Samples process
// health once a second into METRICS_FILE (JSON lines): RSS, heap, event-loop delay (p99/max over the interval),
// and the number of pool queries issued / in flight / failed. Touches no application code.
import { createRequire } from "module";
import { monitorEventLoopDelay } from "perf_hooks";
import fs from "fs";

const require = createRequire("/home/claude/qbooker/server/package.json");
const pg = require("pg");
const out = process.env.METRICS_FILE || "/tmp/load/metrics.jsonl";
fs.writeFileSync(out, "");

const c = { queries: 0, failed: 0, inflight: 0, maxInflight: 0, clientsAcquired: 0, poolErrors: 0, connectWaitMaxMs: 0 };
const origQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (...args) {
  c.queries++; c.inflight++; if (c.inflight > c.maxInflight) c.maxInflight = c.inflight;
  const res = origQuery.apply(this, args);
  if (res && typeof res.then === "function") {
    return res.then((r) => { c.inflight--; return r; }, (e) => { c.inflight--; c.failed++; throw e; });
  }
  c.inflight--; return res;
};
const origConnect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (...args) {
  const t0 = performance.now();
  const res = origConnect.apply(this, args);
  if (res && typeof res.then === "function") {
    c.clientsAcquired++;
    return res.then((cl) => { c.connectWaitMaxMs = Math.max(c.connectWaitMaxMs, performance.now() - t0); return cl; }, (e) => { c.failed++; throw e; });
  }
  return res;
};
const origEmit = pg.Pool.prototype.emit;
pg.Pool.prototype.emit = function (ev, ...a) { if (ev === "error") c.poolErrors++; return origEmit.call(this, ev, ...a); };

const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let last = { ...c };
setInterval(() => {
  const m = process.memoryUsage();
  const row = {
    t: Date.now(), rssMb: +(m.rss / 1048576).toFixed(1), heapMb: +(m.heapUsed / 1048576).toFixed(1),
    lagP99: +(h.percentile(99) / 1e6).toFixed(1), lagMax: +(h.max / 1e6).toFixed(1),
    qps: c.queries - last.queries, queries: c.queries, failed: c.failed, inflight: c.inflight, maxInflight: c.maxInflight,
    poolErrors: c.poolErrors, connectWaitMaxMs: +c.connectWaitMaxMs.toFixed(1), handles: process._getActiveHandles().length,
  };
  last = { ...c }; c.maxInflight = c.inflight; c.connectWaitMaxMs = 0; h.reset();
  fs.appendFileSync(out, JSON.stringify(row) + "\n");
}, 1000).unref();
