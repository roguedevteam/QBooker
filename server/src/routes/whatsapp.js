import crypto from "crypto";
import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { optString } from "../lib/validate.js";
import { rateLimit } from "../lib/rateLimit.js";
import { isProduction } from "../lib/email.js";
import { sendWhatsApp, whatsappStatus } from "../lib/whatsapp.js";
import { t, resolveLang } from "../lib/i18n.js";
import { LINK_CODE_RE, linkPhoneToTicket, forgetPhone } from "../lib/whatsappLinks.js";

const router = Router();

// --- WhatsApp Business Cloud API webhook ---------------------------------------------------------------------
// Meta calls this server-to-server, so there is deliberately no CORS here (a browser has no business calling it).
//
//   GET  /webhook   one-time subscription handshake: answers hub.challenge when hub.verify_token == WHATSAPP_VERIFY_TOKEN
//   POST /webhook   inbound messages. Every call is signed by Meta (X-Hub-Signature-256 = HMAC-SHA256 of the raw body keyed with
//                   the app secret, WHATSAPP_APP_SECRET); unsigned or wrongly signed calls are refused. With no secret configured
//                   it only runs outside production (development and the test suites); in production it answers 503.
//
// Patients are never asked for their number. A message carrying a ticket code (QT-XXXXXX, pre-typed by the "Get updates on WhatsApp" button)
// attaches the sender's number to that one ticket; STOP deletes it. A message carrying a location code (QB-XXXXXX) links that phone to the
// business/location. The full conversation (service menus etc.) is not built yet. Replies go through lib/whatsapp.js.
const env = (name) => (process.env[name] === undefined ? "" : String(process.env[name]).trim());
const webhookLimit = rateLimit({ windowMs: 60 * 1000, max: Number(env("WHATSAPP_WEBHOOK_RATE_PER_MIN")) > 0 ? Number(env("WHATSAPP_WEBHOOK_RATE_PER_MIN")) : 600, message: "Too many requests." });

const safeEqual = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

router.get("/webhook", webhookLimit, (req, res) => {
  const expected = env("WHATSAPP_VERIFY_TOKEN");
  const challenge = typeof req.query["hub.challenge"] === "string" ? req.query["hub.challenge"] : "";
  if (!expected) return res.status(503).type("text/plain").send("Not configured.");
  if (req.query["hub.mode"] !== "subscribe" || typeof req.query["hub.verify_token"] !== "string" || !safeEqual(req.query["hub.verify_token"], expected) || !/^[\w-]{1,200}$/.test(challenge)) {
    return res.status(403).type("text/plain").send("Forbidden.");
  }
  res.status(200).type("text/plain").send(challenge);
});

function verifySignature(req, res, next) {
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret) {
    if (isProduction()) return res.status(503).json({ error: "The WhatsApp webhook is not configured." });
    return next(); // development / tests only
  }
  const header = req.get("x-hub-signature-256") || "";
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (!m || !Buffer.isBuffer(req.rawBody)) return res.status(401).json({ error: "Invalid signature." });
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(m[1].toLowerCase(), "utf8"))) return res.status(401).json({ error: "Invalid signature." });
  next();
}

// One automatic reply per number per 10 minutes, so a chatty or hostile sender can't make us spend messages.
const lastReply = new Map();
function replyAllowed(phone) {
  const now = Date.now();
  if (lastReply.size > 5000) for (const [k, v] of lastReply) if (v < now - 600000) lastReply.delete(k);
  if ((lastReply.get(phone) || 0) > now - 600000) return false;
  lastReply.set(phone, now);
  return true;
}
function reply(phone, key, tenantId) {
  if (!whatsappStatus().ready || !replyAllowed(phone)) return;
  sendWhatsApp({ to: phone, text: t(resolveLang(), key), tenantId }).catch((err) => console.warn(`[whatsapp] reply not sent: ${err.message}`));
}

// Replies that answer something the patient just did (connect, stop) are always sent; only the generic replies are rate limited.
function replyNow(phone, key, vars, tenantId) {
  if (!whatsappStatus().ready) return;
  sendWhatsApp({ to: phone, text: t(resolveLang(), key, vars), tenantId }).catch((err) => console.warn(`[whatsapp] reply not sent: ${err.message}`));
}
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "STOP ALL", "STOPALL"]);

// Handles one inbound text. Returns the (debug) outcome; the HTTP layer decides how much of it to show.
async function handleText(from, text) {
  if (STOP_WORDS.has(text.trim().toUpperCase().replace(/[.!\s]+$/g, ""))) {
    const { tenantId } = await forgetPhone(from);
    replyNow(from, "whatsapp.stopped", {}, tenantId);
    return { ok: true, stopped: true };
  }
  const ticketCode = text.toUpperCase().match(LINK_CODE_RE);
  if (ticketCode) {
    const linked = await linkPhoneToTicket(ticketCode[0], from);
    if (linked.result === "linked") { replyNow(from, "whatsapp.linked", { ticket: linked.ticketNumber }, linked.tenantId); return { ok: true, linked: true }; }
    if (linked.result === "expired") { replyNow(from, "whatsapp.linkExpired", {}, linked.tenantId); return { ok: true, linkExpired: true }; }
    if (linked.result === "taken") return { ok: true, linkTaken: true }; // stay silent: a second number must not learn anything about this ticket
    // unknown code: fall through to the normal handling below
  }
  const codeMatch = text.trim().toUpperCase().match(/QB-[A-Z0-9]{6}/);
  if (codeMatch) {
    const lookup = await query(`select tenant_id, location_id from location_codes where code = $1`, [codeMatch[0]]);
    if (lookup.rows.length > 0) {
      const { tenant_id, location_id } = lookup.rows[0];
      await query(
        `insert into whatsapp_sessions (phone_number, tenant_id, location_id, updated_at)
         values ($1,$2,$3, now())
         on conflict (phone_number) do update set
           tenant_id = excluded.tenant_id, location_id = excluded.location_id, updated_at = now()`,
        [from, tenant_id, location_id]
      );
      reply(from, "whatsapp.connected", tenant_id);
      return { ok: true, matchedCode: codeMatch[0] };
    }
  }
  // No code in this message: fall back to whichever business/location they last scanned.
  const session = await query(`select * from whatsapp_sessions where phone_number = $1`, [from]);
  if (session.rows.length === 0) {
    reply(from, "whatsapp.noSession", null);
    return { ok: true, noSession: true };
  }
  // TODO: conversation-state handling (greet -> choose service -> join queue / book slot) mirrors the /customer app but server-side.
  return { ok: true, session: session.rows[0] };
}

router.post("/webhook", webhookLimit, verifySignature, asyncHandler(async (req, res) => {
  // Detail about which business a phone is linked to is only echoed back in development/tests (no app secret configured). In production
  // the only caller is Meta and the answer is always a bare acknowledgement: nothing about any tenant leaves this endpoint.
  const detailed = !env("WHATSAPP_APP_SECRET") && !isProduction();
  const body = req.body || {};

  // Meta's payload: { object, entry: [{ changes: [{ value: { metadata: { phone_number_id }, messages: [{ from, type, text: { body } }] } }] }] }
  if (body.object !== undefined || Array.isArray(body.entry)) {
    const ourNumberId = env("WHATSAPP_PHONE_ID");
    for (const entry of Array.isArray(body.entry) ? body.entry.slice(0, 20) : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes.slice(0, 20) : []) {
        const value = change?.value;
        if (!value || (ourNumberId && value.metadata?.phone_number_id !== ourNumberId)) continue; // not our number
        for (const m of Array.isArray(value.messages) ? value.messages.slice(0, 50) : []) {
          if (m?.type !== "text" || typeof m.from !== "string" || m.from.length > 40 || typeof m.text?.body !== "string") continue;
          await handleText(m.from, m.text.body.slice(0, 2000));
        }
      }
    }
    return res.json({ ok: true });
  }

  // Simplified { from, text } shape (development, tests, or a different provider's adapter).
  const from = optString(body.from, "from", { max: 40, allowEmpty: true });
  const text = optString(body.text, "text", { max: 2000, allowEmpty: true });
  if (!from || !text) return res.status(400).json({ error: "Missing from/text." });
  const outcome = await handleText(from, text);
  res.json(detailed ? outcome : { ok: true });
}));

export default router;
