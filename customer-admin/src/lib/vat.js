// UK VAT. All prices in the system are stored and calculated EXCLUDING VAT; the VAT-inclusive
// figure is only ever shown alongside, in brackets.
export const VAT_RATE = 0.2;
const money = (n) => { const v = Math.round(Number(n) * 100) / 100; return `£${Number.isInteger(v) ? v : v.toFixed(2)}`; };
export const incVat = (n) => Math.round(Number(n) * (1 + VAT_RATE) * 100) / 100;
export const priceText = (n) => `${money(n)} ex VAT (${money(incVat(n))} inc VAT)`;
export const exMoney = money;
