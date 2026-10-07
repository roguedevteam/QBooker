// UK VAT. All prices in the system are stored and calculated EXCLUDING VAT; shown plainly, with
// the VAT-inclusive figure in brackets.
export const VAT_RATE = 0.2;
// Back-office money is always shown as £ with two decimals so columns and totals line up.
const money = (n) => `£${(Math.round(Number(n) * 100) / 100).toFixed(2)}`;
export const incVat = (n) => Math.round(Number(n) * (1 + VAT_RATE) * 100) / 100;
export const priceText = (n) => `${money(n)} (${money(incVat(n))} inc VAT)`;
export const exMoney = money;
