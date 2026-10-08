// Money, VAT and currency for this app: one place, driven by data. Prices are stored and calculated EXCLUDING VAT
// (tax); shown plainly with the tax-inclusive figure in brackets. The currency comes from the account
// (tenant.currency) and the tax rate/label from the platform's billing settings (GET /api/public/pricing ->
// `billing`). The defaults are the UK ones (GBP, 20%, "VAT"), so nothing changes until an account or the platform says so.
// Amounts are formatted with Intl.NumberFormat in the browser's locale; for GBP in a UK browser that is the familiar "£125".
export const DEFAULT_BILLING = Object.freeze({ currency: "GBP", vatRate: 0.2, vatLabel: "VAT" });
let billing = { ...DEFAULT_BILLING };

// Accepts partial input (an old server may send nothing); anything invalid keeps the current/default value.
export function setBilling(next = {}) {
  const c = typeof next.currency === "string" && /^[A-Za-z]{3}$/.test(next.currency) ? next.currency.toUpperCase() : null;
  const r = Number(next.vatRate);
  const l = typeof next.vatLabel === "string" && next.vatLabel.trim() ? next.vatLabel.trim().slice(0, 12) : null;
  billing = { currency: c || billing.currency, vatRate: next.vatRate != null && Number.isFinite(r) && r >= 0 && r < 1 ? r : billing.vatRate, vatLabel: l || billing.vatLabel };
  formatters.clear();
}
export const getBilling = () => billing;
export const vatLabel = () => billing.vatLabel;
export const vatPercent = () => Math.round(billing.vatRate * 10000) / 100; // 20, 17.5 ...

const formatters = new Map();
function formatter(fixed) {
  const key = `${billing.currency}|${fixed}`;
  let f = formatters.get(key);
  if (!f) {
    try { f = new Intl.NumberFormat(undefined, { style: "currency", currency: billing.currency, ...(fixed ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {}) }); }
    catch { f = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP" }); }
    formatters.set(key, f);
  }
  return f;
}
// "£125" for whole amounts, "£12.50" otherwise (customer-facing); fixed=true always shows the minor units (tables, totals).
export function formatMoney(n, { fixed = false } = {}) {
  const v = Math.round(Number(n) * 100) / 100;
  const f = formatter(fixed);
  if (fixed || !Number.isInteger(v)) return f.format(v);
  return new Intl.NumberFormat(undefined, { style: "currency", currency: f.resolvedOptions().currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
}
export const exMoney = (n) => formatMoney(n);
export const incVat = (n) => Math.round(Number(n) * (1 + billing.vatRate) * 100) / 100;
export const vatOf = (n) => incVat(n) - Number(n);
export const priceText = (n) => `${formatMoney(n)} (${formatMoney(incVat(n))} inc ${billing.vatLabel})`;
// The currency's own symbol ("£", "$", "€"), for labels like "Price £".
export function currencySymbol() {
  try { return formatter(true).formatToParts(0).find((p) => p.type === "currency")?.value || billing.currency; } catch { return billing.currency; }
}
