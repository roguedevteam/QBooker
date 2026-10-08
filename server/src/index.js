import http from "http";
import express from "express";
import cors from "cors";
import "dotenv/config";

import authRoutes from "./routes/auth.js";
import tenantRoutes from "./routes/tenant.js";
import systemRoutes, { publicRouter } from "./routes/system.js";
import customerPublicRoutes, { publicTicketRouter } from "./routes/customerPublic.js";
import publicCodesRoutes from "./routes/publicCodes.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { closeStaleTickets } from "./lib/closeStaleTickets.js";
import { sweepLicences } from "./lib/serviceLicense.js";
import { HttpError } from "./lib/validate.js";
import { reportEmailConfig } from "./lib/email.js";

const app = express();
app.disable("x-powered-by");
// Railway/Render sit in front of this as a reverse proxy — without this, req.ip is always the
// proxy's own address, which would make every signup look like it's coming from the same place.
// Trust exactly TRUST_PROXY proxy hops (default 1, which fits Railway): the client IP is then the
// address the nearest proxy saw, and a client-supplied X-Forwarded-For can't fake another one.
// Use 0 if the app is exposed directly with no proxy in front.
const trustProxyHops = process.env.TRUST_PROXY === undefined || process.env.TRUST_PROXY === "" ? 1 : Number(process.env.TRUST_PROXY);
app.set("trust proxy", Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

// Security headers for every API response (a helmet-style baseline without the dependency). The API only
// serves JSON, so the CSP forbids everything and framing; HSTS is sent when the request arrived over TLS
// (behind the proxy: req.secure honours trust proxy). The static sites need their own CSP/frame-ancestors at
// the host (Render/Netlify/Vercel headers) - that is out of scope for this server.
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});
// Signed-in responses (admin/staff data, session tokens) must never sit in a shared or browser cache.
app.use(["/api/auth", "/api/tenant", "/api/system"], (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
// X-Session-Token carries the refreshed session token (sliding sessions); browsers only let the apps read it if exposed.
const restrictedCors = cors({ origin: allowedOrigins, credentials: true, exposedHeaders: ["X-Session-Token"] });
// Public data (service names, opening hours, location codes) is meant to be reachable from
// anywhere, so it isn't restricted to the fixed origin list the authenticated apps use.
const openCors = cors();

// Every real request body here is a small JSON object; 100 kB is generous and caps what one request can make the server buffer.
// The WhatsApp webhook is signed over the exact bytes Meta sent, so keep the raw body for that path only.
app.use(express.json({
  limit: process.env.BODY_LIMIT || "100kb",
  verify: (req, res, buf) => { if (req.originalUrl.startsWith("/api/whatsapp/")) req.rawBody = Buffer.from(buf); },
}));
// Bodies are always JSON objects; an array (or anything else) is a malformed request.
app.use((req, res, next) => {
  if (Array.isArray(req.body)) return res.status(400).json({ error: "Request body must be a JSON object." });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", restrictedCors, authRoutes);
app.use("/api/tenant", restrictedCors, tenantRoutes);
app.use("/api/system", restrictedCors, systemRoutes);
app.use("/api/public", openCors, publicRouter);
app.use("/api/public/tenant", openCors, customerPublicRoutes);
app.use("/api/public/ticket", openCors, publicTicketRouter);
app.use("/api/public/code", openCors, publicCodesRoutes);
// Server-to-server (Meta calls it): no CORS at all, requests are authenticated by signature instead.
app.use("/api/whatsapp", whatsappRoutes);

// Anything that matched no route: a JSON 404 (Express' default is an HTML page that echoes the path and replaces our headers).
app.use((req, res) => res.status(404).json({ error: "Not found." }));

// Errors that mean "the database can't serve this right now" rather than "this request is broken".
const DB_UNAVAILABLE_CODES = /^(08|53|57P0|55P03|57014|25P03)/; // connection, resources, shutdown/startup, lock/statement/idle-tx timeout
const DB_UNAVAILABLE_NET = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
let lastDbWarn = 0;
function isDbUnavailable(err) {
  if (!err) return false;
  if (typeof err.code === "string" && (DB_UNAVAILABLE_CODES.test(err.code) || DB_UNAVAILABLE_NET.has(err.code))) return true;
  if (Array.isArray(err.errors) && err.errors.length && err.errors.every(isDbUnavailable)) return true; // AggregateError (dual-stack connect)
  return /timeout exceeded when trying to connect|Connection terminated|Query read timeout|connection timeout|Client has encountered a connection error/i.test(String(err.message));
}

// Client mistakes (bad JSON, oversized body, validation failures) are answered with their own 4xx
// and a short message. Database "bad value" errors that slip past validation are also 4xx. Only
// genuine server faults are logged and answered with a 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) {
    let error = err instanceof HttpError ? err.message : "Bad request.";
    if (err.type === "entity.too.large") error = "That request is too large.";
    else if (err.type === "entity.parse.failed") error = "The request body isn't valid JSON.";
    return res.status(status).json({ error, ...(err instanceof HttpError ? err.extra : {}) });
  }
  if (typeof err.code === "string" && /^(22|23)/.test(err.code)) {
    console.warn(`[client input] database rejected a value (${err.code}${err.constraint ? ` ${err.constraint}` : ""})`);
    if (err.code === "23505") return res.status(409).json({ error: "That already exists." });
    return res.status(400).json({ error: "One of the values sent isn't acceptable." });
  }
  // The database is unreachable, restarting, out of connections or too slow (pool exhausted / timeouts): tell the client to
  // try again shortly (503 + Retry-After) rather than a generic 500. The apps already treat a failed poll as "offline, retry".
  if (isDbUnavailable(err)) {
    if (Date.now() - lastDbWarn > 5000) { lastDbWarn = Date.now(); console.warn(`[db] unavailable (503s are being sent; logged at most every 5 s): ${err.code || ""} ${err.message}`); }
    res.set("Retry-After", "5");
    return res.status(503).json({ error: "The service is busy or restarting. Please try again in a few seconds." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

// Sessions are signed with JWT_SECRET: without one every sign-in would fail, and a short one is guessable.
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set - refusing to start.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET.length < 32) {
  console.warn("JWT_SECRET is shorter than 32 characters - use a long random value in production.");
}
reportEmailConfig(); // loud warning (not a crash) when sign-in emails can't be delivered; the sign-in endpoints then answer 503
if (process.env.QB_TEST_NOW) console.warn(`TEST CLOCK ACTIVE (QB_TEST_NOW=${process.env.QB_TEST_NOW}) - never set this in production.`);

const port = process.env.PORT || 4000;
// Node waits 60 s for headers and 5 min for a whole request by default, and only checks every 30 s, which lets a handful of
// slow sockets (slowloris) tie up connections for minutes. Tighter, env-tunable limits; keep-alive stays above the usual
// 60 s idle timeout of Railway/Render-style proxies so a reused connection is never closed under an in-flight request (502s).
const msEnv = (name, dflt) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n > 0 ? n : dflt; };
const server = http.createServer({ connectionsCheckingInterval: 5000 }, app);
server.headersTimeout = msEnv("HTTP_HEADERS_TIMEOUT_MS", 15000);
server.requestTimeout = msEnv("HTTP_REQUEST_TIMEOUT_MS", 30000);
server.keepAliveTimeout = msEnv("HTTP_KEEPALIVE_TIMEOUT_MS", 65000);
server.listen(port, () => console.log(`QBooker API listening on port ${port}`));

// End-of-day sweep: tickets still in progress after their day are system-closed.
setInterval(() => { closeStaleTickets().catch((err) => console.error("closeStaleTickets failed", err)); }, 10 * 60 * 1000);
closeStaleTickets().catch((err) => console.error("closeStaleTickets failed", err));
// Licence status sweep: scheduled/active licences are moved on (expired, activated, or returned to Available) per location time zone,
// so the stored status never goes stale just because nobody opened a screen. Cheap: it only touches licences that are due.
setInterval(() => { sweepLicences().catch((err) => console.error("sweepLicences failed", err)); }, 5 * 60 * 1000);
sweepLicences().catch((err) => console.error("sweepLicences failed", err));

// Safety net: an unhandled promise rejection (e.g. a database call that wasn't
// wrapped in try/catch) would otherwise crash the whole process on Node 15+.
// This keeps the server alive and logs it instead — the specific request that
// triggered it will time out, but everything else keeps working.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stayed up):", reason);
});
