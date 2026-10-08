// Outbound email behind a small provider interface, chosen by environment (no code change to switch):
//
//   EMAIL_PROVIDER=resend   real delivery through Resend's HTTPS API (RESEND_API_KEY, EMAIL_FROM required)
//   EMAIL_PROVIDER=log      nothing leaves the server; messages go to the in-memory outbox / simulated_messages.
//                           For development, tests and demos only. Ready only outside production, or when DEMO_MODE=true.
//   (unset)                 "log" outside production, "not configured" in production (sign-in then fails closed).
//
// More providers (SES, Postmark, SMTP ...) are one object with { name, isReady(), send(message) } passed to
// registerEmailProvider(); the rest of the app only ever calls sendTemplatedEmail().
//
// Secrets and message bodies are never written to the process log: a failure logs the provider, the HTTP status and the
// provider's error *name* only.
import crypto from "crypto";
import { query } from "../db/pool.js";
import { t, resolveLang } from "./i18n.js";

const env = (name) => (process.env[name] === undefined ? "" : String(process.env[name]).trim());
const truthy = (v) => String(v).toLowerCase() === "true";

export const appName = () => env("APP_NAME") || "QBooker";
// Production = NODE_ENV=production or a Railway deployment (Railway sets these). NODE_ENV=test always wins, so the suites are unaffected.
export const isProduction = () => env("NODE_ENV") !== "test" && (env("NODE_ENV") === "production" || !!env("RAILWAY_ENVIRONMENT") || !!env("RAILWAY_PROJECT_ID"));
export const demoModeFlag = () => truthy(env("DEMO_MODE"));

// --- Errors ---------------------------------------------------------------------------------------
// Thrown when a message could not be handed to the provider. `statusCode` makes the API answer 503 with a plain message.
export class EmailError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "EmailError";
    this.statusCode = 503;
    this.retryable = retryable;
    this.expose = true;
  }
}
export const SEND_FAILED_MESSAGE = "We couldn't send the code just now. Please try again in a moment.";
export const NOT_CONFIGURED_MESSAGE = "Sign-in by email isn't switched on for this service yet. Please contact support.";

// --- Providers ------------------------------------------------------------------------------------
const OUTBOX_MAX = 200;
const outbox = [];
// In-memory copy of what the log provider "sent" (most recent last). Only kept when codes may be shown (test / DEMO_MODE).
export const getOutbox = () => outbox.slice();
export const clearOutbox = () => { outbox.length = 0; };

const logProvider = {
  name: "log",
  isReady: () => !isProduction() || demoModeFlag(),
  async send(message, ctx = {}) {
    const keepBody = demoOtpAllowed();
    if (keepBody) {
      outbox.push({ ...message, at: new Date().toISOString() });
      if (outbox.length > OUTBOX_MAX) outbox.shift();
    }
    // The database log keeps the subject always, the text only where codes are allowed to be seen.
    await query(
      `insert into simulated_messages (tenant_id, channel, to_reference, body) values ($1, 'email', $2, $3)`,
      [ctx.tenantId || null, message.to, keepBody ? `${message.subject}\n\n${message.text}` : `${message.subject}\n\n[message body not stored]`]
    );
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msEnv = (name, dflt) => { const n = Number(env(name)); return env(name) && Number.isFinite(n) && n >= 0 ? n : dflt; };

const resendProvider = {
  name: "resend",
  isReady: () => !!env("RESEND_API_KEY") && !!env("EMAIL_FROM"),
  async send(message) {
    const url = env("RESEND_API_URL") || "https://api.resend.com/emails";
    const body = JSON.stringify({
      from: message.from, to: [message.to], subject: message.subject, text: message.text, html: message.html,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    });
    // The same idempotency key on the retry means a slow first attempt that did go through is not delivered twice.
    const idempotencyKey = crypto.randomUUID();
    let lastRetryable = true;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body,
          signal: AbortSignal.timeout(msEnv("EMAIL_TIMEOUT_MS", 8000)),
        });
        if (res.ok) return;
        let errName = "";
        try { errName = String((await res.json())?.name || "").slice(0, 60); } catch { /* not JSON */ }
        lastRetryable = res.status >= 500;
        console.warn(`[email] resend rejected a message (HTTP ${res.status}${errName ? `, ${errName}` : ""}) attempt ${attempt}/2`);
        if (!lastRetryable) break; // 4xx: a bad key, an unverified domain, a bad address: retrying cannot help
      } catch (err) {
        lastRetryable = true;
        console.warn(`[email] resend request failed (${err?.name === "TimeoutError" ? "timeout" : err?.code || err?.name || "network error"}) attempt ${attempt}/2`);
      }
      if (attempt === 1 && lastRetryable) await sleep(msEnv("EMAIL_RETRY_DELAY_MS", 400));
      else break;
    }
    throw new EmailError("The email provider did not accept the message.", { retryable: lastRetryable });
  },
};

const providers = { log: logProvider, resend: resendProvider };
export function registerEmailProvider(provider) {
  if (!provider?.name || typeof provider.send !== "function" || typeof provider.isReady !== "function") throw new Error("An email provider needs name, isReady() and send().");
  providers[provider.name] = provider;
}

// --- Which provider is active, and is it usable? ---------------------------------------------------------
export function emailStatus() {
  const raw = env("EMAIL_PROVIDER").toLowerCase();
  const name = raw || (isProduction() && !demoModeFlag() ? "" : "log");
  const provider = providers[name];
  if (!name) return { provider: "", ready: false, reason: "EMAIL_PROVIDER is not set" };
  if (!provider) return { provider: name, ready: false, reason: `EMAIL_PROVIDER="${name}" is not a known provider (use "resend")` };
  if (!provider.isReady()) {
    const reason = name === "log" ? 'the "log" provider is for development only and is switched off in production (set DEMO_MODE=true only for a demo)'
      : name === "resend" ? "RESEND_API_KEY and EMAIL_FROM must both be set" : `provider "${name}" is not fully configured`;
    return { provider: name, ready: false, reason };
  }
  return { provider: name, ready: true, reason: "" };
}
export const emailReady = () => emailStatus().ready;

// Sign-in codes may be shown in an HTTP response only when nothing real is being sent AND this is a test run or an explicit demo.
export function demoOtpAllowed() {
  const s = emailStatus();
  return s.provider === "log" && s.ready && (env("NODE_ENV") === "test" || demoModeFlag());
}

// Called once at start-up. Never throws: a misconfigured server still starts, and the sign-in endpoints answer 503.
export function reportEmailConfig() {
  const s = emailStatus();
  if (!s.ready) {
    console.error("");
    console.error("##########################################################################################");
    console.error(`# EMAIL IS NOT SET UP (${s.reason}).`);
    console.error("# Nobody can receive a sign-in code, so sign-in and sign-up answer 503 until this is fixed.");
    console.error("# Set EMAIL_PROVIDER=resend, RESEND_API_KEY and EMAIL_FROM - see docs/EMAIL_AND_SECURITY_SETUP.md.");
    console.error("##########################################################################################");
    console.error("");
  } else if (s.provider === "log" && isProduction()) {
    console.error("# WARNING: DEMO_MODE=true with the log email provider on a production-looking server: sign-in codes are returned to anyone who asks. Demo only.");
  } else if (s.provider === "log" && !demoOtpAllowed()) {
    console.warn('# Email provider "log": no email is sent and codes are not shown. Set DEMO_MODE=true while developing locally to see them.');
  }
  if (isProduction() && env("JWT_SECRET") && !env("OTP_PEPPER")) console.warn("# OTP_PEPPER is not set: sign-in codes are hashed with JWT_SECRET instead. Set a separate OTP_PEPPER.");
  return s;
}

// --- Message building -------------------------------------------------------------------------------
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brandColor = () => (/^#[0-9a-fA-F]{6}$/.test(env("EMAIL_BRAND_COLOR")) ? env("EMAIL_BRAND_COLOR") : "#1D5C8A");

// template -> catalogue keys. `code` templates show a big code; "disabled" shows a plain notice.
const TEMPLATES = {
  "otp":      { subject: "email.otp.subject",      intro: "email.otp.intro",      withCode: true, expiry: true, ignore: true },
  "signup":   { subject: "email.signup.subject",   intro: "email.signup.intro",   withCode: true, expiry: true, ignore: true },
  "exists":   { subject: "email.exists.subject",   intro: "email.exists.intro",   withCode: true, expiry: true, ignore: true },
  "disabled": { subject: "email.disabled.subject", intro: "email.disabled.intro", action: "email.disabled.action" },
};

export function buildMessage({ to, template, lang, code, minutes }) {
  const spec = TEMPLATES[template];
  if (!spec) throw new Error(`unknown email template ${template}`);
  const l = resolveLang(lang);
  const vars = { app: appName(), minutes };
  const lines = [t(l, spec.intro, vars)];
  const tail = [];
  if (spec.expiry) tail.push(t(l, "email.otp.expiry", vars));
  if (spec.action) tail.push(t(l, spec.action, vars));
  if (spec.ignore) tail.push(t(l, "email.otp.ignore", vars));
  const footer = t(l, "email.footer", vars);
  const subject = t(l, spec.subject, vars);
  const text = [...lines, ...(spec.withCode ? ["", code, ""] : [""]), ...tail, "", "--", footer].join("\n");
  const color = brandColor();
  const html = `<!doctype html><html lang="${esc(l)}"><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1b2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:8px;border-top:4px solid ${color}">
<tr><td style="padding:24px 28px 8px;font-size:18px;font-weight:bold;color:${color}">${esc(appName())}</td></tr>
<tr><td style="padding:8px 28px;font-size:15px;line-height:1.5">${esc(lines[0])}</td></tr>
${spec.withCode ? `<tr><td style="padding:8px 28px"><div style="font-family:'Courier New',monospace;font-size:32px;letter-spacing:6px;font-weight:bold;padding:14px 0;text-align:center;background:#f4f6f8;border-radius:6px">${esc(code)}</div></td></tr>` : ""}
${tail.map((p) => `<tr><td style="padding:6px 28px;font-size:14px;line-height:1.5;color:#44505f">${esc(p)}</td></tr>`).join("\n")}
<tr><td style="padding:20px 28px 24px;font-size:12px;color:#7a8594">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { to, from: env("EMAIL_FROM") || `${appName()} <no-reply@localhost>`, replyTo: env("EMAIL_REPLY_TO") || undefined, subject, text, html };
}

const ADDRESS_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

// Sends one templated message. Throws EmailError (503) when the provider is unavailable or refuses it.
export async function sendTemplatedEmail({ to, template, lang, code, minutes, tenantId }) {
  const status = emailStatus();
  if (!status.ready) throw Object.assign(new EmailError(NOT_CONFIGURED_MESSAGE), { notConfigured: true });
  if (typeof to !== "string" || to.length > 254 || !ADDRESS_RE.test(to)) throw new EmailError("That address can't receive email.");
  const message = buildMessage({ to, template, lang, code, minutes });
  try {
    await providers[status.provider].send(message, { tenantId });
  } catch (err) {
    if (err instanceof EmailError) throw err;
    // e.g. the log provider's database insert failed: a send failure either way
    console.warn(`[email] ${status.provider} send failed: ${err?.code || err?.name || "error"}`);
    throw new EmailError("The email provider did not accept the message.", { retryable: true });
  }
}

// --- Timing: make "no such account" take as long as "account found, code sent" ---------------------------------
// The caller wraps the real work in track() and, for an unknown address, awaits mimic() (sleeps about the recent average).
export function createLatencyMirror() {
  let avg = 0;
  const record = (d) => { avg = avg ? avg * 0.8 + d * 0.2 : d; };
  return {
    record,
    async track(fn) {
      const started = Date.now();
      try { return await fn(); } finally { record(Date.now() - started); }
    },
    async mimic() {
      if (avg > 0) await sleep(Math.round(avg * (0.9 + crypto.randomInt(0, 21) / 100)));
    },
  };
}
