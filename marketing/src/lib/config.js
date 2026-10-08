// Deployment-level settings for the marketing site, all optional (build-time VITE_* env vars).

// The single contact address used everywhere on the site (mailto links, privacy notice).
// Set VITE_SUPPORT_EMAIL on the static service; the default is a placeholder so nothing breaks.
export const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL || "").trim() || "hello@qbooker.example";

export function mailto(subject) {
  return `mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}

// Public URL of this site (no trailing slash), e.g. https://www.example.com. Used for the canonical
// link, Open Graph URL and the sitemap/robots files written at build time (see vite.config.js).
// Unset = those tags are simply left out.
export const MARKETING_URL = (import.meta.env.VITE_MARKETING_URL || "").trim().replace(/\/+$/, "");
