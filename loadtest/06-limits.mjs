// Scenario 6 - request-size and slow-client limits against the live API (:4300).
import net from "net";
import { http, report, table, sleep, BASE, randIp, logErrors, logSize } from "./lib.mjs";
const logStart = logSize();
const u = new URL(BASE); const port = Number(u.port); const host = u.hostname;
const rows = [];
const big = (n) => JSON.stringify({ email: "a@example.com", pad: "x".repeat(n) });
for (const [label, n] of [["90 kB JSON", 90_000], ["200 kB JSON", 200_000], ["5 MB JSON", 5_000_000]]) {
  const r = await http("POST", "/api/auth/admin/request-otp", { raw: big(n), headers: { "content-type": "application/json" }, ip: randIp() });
  rows.push([`POST ${label}`, `${r.status || r.error} ${r.json?.error || ""}`]);
}
const bad = await http("POST", "/api/auth/admin/request-otp", { raw: "{not json", headers: { "content-type": "application/json" }, ip: randIp() });
rows.push(["malformed JSON", `${bad.status} ${bad.json?.error}`]);
const hdr = await http("GET", "/health", { headers: { "x-big": "y".repeat(20000) } });
rows.push(["one 20 kB header", `${hdr.status || hdr.error}`]);

function raw(send, waitMs) {
  return new Promise((resolve) => {
    const s = net.connect(port, host); const t0 = Date.now(); let first = ""; let done = false;
    const fin = (why) => { if (done) return; done = true; s.destroy(); resolve({ why, ms: Date.now() - t0, first }); };
    s.on("data", (d) => { if (!first) first = String(d).split("\r\n")[0]; });
    s.on("close", () => fin("closed by server"));
    s.on("error", () => fin("error"));
    send(s);
    setTimeout(() => fin("still open (client gave up)"), waitMs);
  });
}
const slowHeaders = await raw((s) => s.write("GET /health HTTP/1.1\r\nHost: x\r\nX-Slow: 1\r\n"), 70000);
rows.push(["slowloris: headers never finished", `${slowHeaders.why} after ${(slowHeaders.ms / 1000).toFixed(1)} s ${slowHeaders.first}`]);
const slowBody = await raw((s) => { s.write("POST /api/auth/admin/request-otp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"); const iv = setInterval(() => s.write(" "), 5000); s.on("close", () => clearInterval(iv)); }, 100000);
rows.push(["slow body: 1 byte / 5 s, 1000 declared", `${slowBody.why} after ${(slowBody.ms / 1000).toFixed(1)} s ${slowBody.first}`]);
// many idle sockets
const socks = []; for (let i = 0; i < 300; i++) { const s = net.connect(port, host); s.on("error", () => {}); socks.push(s); }
await sleep(1000);
const h = await http("GET", "/health", { timeoutMs: 3000 });
rows.push(["300 idle open sockets, then /health", `${h.status} in ${h.ms.toFixed(0)} ms`]);
socks.forEach((s) => s.destroy());
rows.push(["server log errors", logErrors(logStart).length]);
report("Scenario 6 - body limit and slow clients", table(["case", "result"], rows));
process.exit(0);
