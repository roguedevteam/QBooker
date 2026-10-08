// Money, VAT and currency for the platform back office. Revenue is recorded in the platform's pricing currency
// (platform_settings 'billing', default GBP) and prices are ex VAT (tax). Back-office amounts always show two
// decimals so columns and totals line up. Formatting uses Intl.NumberFormat in the browser's locale.
// Revenue reports use UTC dates and say so on the page.
export const DEFAULT_BILLING = Object.freeze({ currency: "GBP", vatRate: 0.2, vatLabel: "VAT" });
let billing = { ...DEFAULT_BILLING };
const formatters = new Map();

export function setBilling(next = {}) {
  const c = typeof next.currency === "string" && /^[A-Za-z]{3}$/.test(next.currency) ? next.currency.toUpperCase() : null;
  const r = Number(next.vatRate);
  const l = typeof next.vatLabel === "string" && next.vatLabel.trim() ? next.vatLabel.trim().slice(0, 12) : null;
  billing = { currency: c || billing.currency, vatRate: next.vatRate != null && Number.isFinite(r) && r >= 0 && r < 1 ? r : billing.vatRate, vatLabel: l || billing.vatLabel };
  formatters.clear();
}
export const getBilling = () => billing;
export const vatLabel = () => billing.vatLabel;
export const vatPercent = () => Math.round(billing.vatRate * 10000) / 100;

function formatter() {
  let f = formatters.get(billing.currency);
  if (!f) {
    try { f = new Intl.NumberFormat(undefined, { style: "currency", currency: billing.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch { f = new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    formatters.set(billing.currency, f);
  }
  return f;
}
export const formatMoney = (n) => formatter().format(Math.round(Number(n) * 100) / 100);
export const exMoney = formatMoney;
export const incVat = (n) => Math.round(Number(n) * (1 + billing.vatRate) * 100) / 100;
export const priceText = (n) => `${formatMoney(n)} (${formatMoney(incVat(n))} inc ${billing.vatLabel})`;
export function currencySymbol() {
  try { return formatter().formatToParts(0).find((p) => p.type === "currency")?.value || billing.currency; } catch { return billing.currency; }
}
// Axis labels on charts: symbol + whole amount.
export const moneyTick = (v) => `${currencySymbol()}${v}`;
