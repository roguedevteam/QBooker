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
import { HttpError } from "./lib/validate.js";

const app = express();
app.disable("x-powered-by");
// Railway/Render sit in front of this as a reverse proxy — without this, req.ip is always the
// proxy's own address, which would make every signup look like it's coming from the same place.
// Trust exactly TRUST_PROXY proxy hops (default 1, which fits Railway): the client IP is then the
// address the nearest proxy saw, and a client-supplied X-Forwarded-For can't fake another one.
// Use 0 if the app is exposed directly with no proxy in front.
const trustProxyHops = process.env.TRUST_PROXY === undefined || process.env.TRUST_PROXY === "" ? 1 : Number(process.env.TRUST_PROXY);
app.set("trust proxy", Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
const restrictedCors = cors({ origin: allowedOrigins, credentials: true });
// Public data (service names, opening hours, location codes) is meant to be reachable from
// anywhere, so it isn't restricted to the fixed origin list the authenticated apps use.
const openCors = cors();

app.use(express.json());
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
app.use("/api/whatsapp", openCors, whatsappRoutes);

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
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`QBooker API listening on port ${port}`));

// End-of-day sweep: tickets still in progress after their day are system-closed.
setInterval(() => { closeStaleTickets().catch((err) => console.error("closeStaleTickets failed", err)); }, 10 * 60 * 1000);
closeStaleTickets().catch((err) => console.error("closeStaleTickets failed", err));

// Safety net: an unhandled promise rejection (e.g. a database call that wasn't
// wrapped in try/catch) would otherwise crash the whole process on Node 15+.
// This keeps the server alive and logs it instead — the specific request that
// triggered it will time out, but everything else keeps working.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stayed up):", reason);
});
