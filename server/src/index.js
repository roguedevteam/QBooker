import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

import authRoutes from "./routes/auth.js";
import tenantRoutes from "./routes/tenant.js";
import systemRoutes, { publicRouter } from "./routes/system.js";
import customerPublicRoutes from "./routes/customerPublic.js";
import publicCodesRoutes from "./routes/publicCodes.js";
import whatsappRoutes from "./routes/whatsapp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
const restrictedCors = cors({ origin: allowedOrigins, credentials: true });
// Public data (service names, opening hours, location codes) is meant to be reachable from
// anywhere — the embeddable widget runs on arbitrary third-party business websites, so it
// can't be restricted to a fixed origin list the way the authenticated apps are.
const openCors = cors();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"))); // serves /widget.js

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", restrictedCors, authRoutes);
app.use("/api/tenant", restrictedCors, tenantRoutes);
app.use("/api/system", restrictedCors, systemRoutes);
app.use("/api/public", openCors, publicRouter);
app.use("/api/public/tenant", openCors, customerPublicRoutes);
app.use("/api/public/code", openCors, publicCodesRoutes);
app.use("/api/whatsapp", openCors, whatsappRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`QBooker API listening on port ${port}`));

// Safety net: an unhandled promise rejection (e.g. a database call that wasn't
// wrapped in try/catch) would otherwise crash the whole process on Node 15+.
// This keeps the server alive and logs it instead — the specific request that
// triggered it will time out, but everything else keeps working.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stayed up):", reason);
});
