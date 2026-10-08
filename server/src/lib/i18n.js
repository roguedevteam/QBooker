// Text the server itself sends to people (sign-in emails, WhatsApp replies). Everything is looked up by key and
// language, so adding a language later is one more block in CATALOGUE - no code changes. Wording is kept
// neutral: no country, currency, date or phone-format assumptions in any sentence.
//
//   {name} placeholders are filled from `vars`. Values are inserted as plain text; the HTML email builder
//   escapes them itself, so a catalogue string must never contain markup.
const CATALOGUE = {
  en: {
    "email.otp.subject": "Your {app} sign-in code",
    "email.otp.intro": "Use this code to sign in to {app}:",
    "email.otp.expiry": "It works once and expires in {minutes} minutes.",
    "email.otp.ignore": "If you didn't ask for this code, you can safely ignore this email. Nobody can sign in without it.",
    "email.signup.subject": "Welcome to {app} - your sign-in code",
    "email.signup.intro": "Thanks for signing up to {app}. Use this code to finish signing in:",
    "email.exists.subject": "You already have a {app} account",
    "email.exists.intro": "Someone, hopefully you, tried to create a new {app} account with this email address, but an account already exists. To sign in instead, use this code:",
    "email.disabled.subject": "Your {app} account is switched off",
    "email.disabled.intro": "Someone asked to sign in to the {app} account for this email address, but the account is currently switched off.",
    "email.disabled.action": "Please contact support to have it switched back on.",
    "email.footer": "Sent by {app}. This is an automated message.",
    "whatsapp.call": "It's your turn! Please come to {room}.",
    "whatsapp.noSession": "Hi! To get started, scan the QR code at the location you're visiting.",
    "whatsapp.connected": "Thanks, you're connected.",
  },
};

export const DEFAULT_LANG = "en";
export const supportedLangs = () => Object.keys(CATALOGUE);

// Accepts "en", "en-GB", "EN_us", an Accept-Language header ("fr-CH, fr;q=0.9, en;q=0.8") or garbage; returns a
// language we have a catalogue for, falling back to DEFAULT_LANG_ENV / "en".
export function resolveLang(candidate) {
  const fallback = CATALOGUE[String(process.env.DEFAULT_LANG || "").toLowerCase()] ? String(process.env.DEFAULT_LANG).toLowerCase() : DEFAULT_LANG;
  if (typeof candidate !== "string") return fallback;
  for (const part of candidate.slice(0, 200).split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase().replace("_", "-");
    const base = tag.split("-")[0];
    if (CATALOGUE[tag]) return tag;
    if (CATALOGUE[base]) return base;
  }
  return fallback;
}

export function t(lang, key, vars = {}) {
  const table = CATALOGUE[lang] || CATALOGUE[DEFAULT_LANG];
  const template = table[key] ?? CATALOGUE[DEFAULT_LANG][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}
