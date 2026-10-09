// Outbound WhatsApp behind a provider interface, chosen by environment:
//
//   WHATSAPP_PROVIDER=log          (default) records the message in simulated_messages; nothing is delivered.
//   WHATSAPP_PROVIDER=meta-cloud   WhatsApp Business Cloud API (Meta). Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_ID.
//                                  Optional: WHATSAPP_API_URL (default https://graph.facebook.com), WHATSAPP_API_VERSION (default v21.0).
//
// Going live is configuration only. Tokens and message bodies are never written to the process log.
import { query } from "../db/pool.js";

const env = (name) => (process.env[name] === undefined ? "" : String(process.env[name]).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msEnv = (name, dflt) => { const n = Number(env(name)); return env(name) && Number.isFinite(n) && n >= 0 ? n : dflt; };

export class WhatsAppError extends Error {
  constructor(message) { super(message); this.name = "WhatsAppError"; }
}

const logProvider = {
  name: "log",
  isReady: () => true,
  async send({ to, text }, ctx = {}) {
    // Only the last four digits are logged: the simulated log is not allowed to become a second copy of a patient's number.
    const masked = `whatsapp:...${String(to).replace(/\D/g, "").slice(-4)}`;
    await query(`insert into simulated_messages (tenant_id, channel, to_reference, body) values ($1, 'whatsapp', $2, $3)`, [ctx.tenantId || null, masked, text]);
  },
};

const metaCloudProvider = {
  name: "meta-cloud",
  isReady: () => !!env("WHATSAPP_TOKEN") && !!env("WHATSAPP_PHONE_ID"),
  async send({ to, text }) {
    const base = (env("WHATSAPP_API_URL") || "https://graph.facebook.com").replace(/\/+$/, "");
    const url = `${base}/${env("WHATSAPP_API_VERSION") || "v21.0"}/${encodeURIComponent(env("WHATSAPP_PHONE_ID"))}/messages`;
    const body = JSON.stringify({ messaging_product: "whatsapp", to: String(to).replace(/[^\d]/g, ""), type: "text", text: { body: text, preview_url: false } });
    let retryable = true;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(msEnv("WHATSAPP_TIMEOUT_MS", 8000)),
        });
        if (res.ok) return;
        retryable = res.status >= 500;
        console.warn(`[whatsapp] meta-cloud rejected a message (HTTP ${res.status}) attempt ${attempt}/2`);
        if (!retryable) break;
      } catch (err) {
        retryable = true;
        console.warn(`[whatsapp] meta-cloud request failed (${err?.name === "TimeoutError" ? "timeout" : err?.code || err?.name || "network error"}) attempt ${attempt}/2`);
      }
      if (attempt === 1) await sleep(msEnv("WHATSAPP_RETRY_DELAY_MS", 400));
    }
    throw new WhatsAppError("WhatsApp did not accept the message.");
  },
};

const providers = { log: logProvider, "meta-cloud": metaCloudProvider };
export function registerWhatsAppProvider(provider) {
  if (!provider?.name || typeof provider.send !== "function" || typeof provider.isReady !== "function") throw new Error("A WhatsApp provider needs name, isReady() and send().");
  providers[provider.name] = provider;
}

export function whatsappStatus() {
  const name = env("WHATSAPP_PROVIDER").toLowerCase() || "log";
  const provider = providers[name];
  if (!provider) return { provider: name, ready: false, reason: `WHATSAPP_PROVIDER="${name}" is not a known provider (use "log" or "meta-cloud")` };
  if (!provider.isReady()) return { provider: name, ready: false, reason: "WHATSAPP_TOKEN and WHATSAPP_PHONE_ID must both be set" };
  return { provider: name, ready: true, reason: "" };
}

// Sends one text message. Throws WhatsAppError when the provider is not configured or refuses it.
export async function sendWhatsApp({ to, text, tenantId }) {
  const status = whatsappStatus();
  if (!status.ready) throw new WhatsAppError(status.reason);
  try {
    await providers[status.provider].send({ to, text }, { tenantId });
  } catch (err) {
    if (err instanceof WhatsAppError) throw err;
    throw new WhatsAppError("WhatsApp send failed.");
  }
}
