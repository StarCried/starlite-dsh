/** Read-only financial summary. Never includes credentials or session identity. */
export type BillingCurrency = "CNY" | "USD";
export interface BillingSnapshot {
  billingVersion: 1;
  checkedAt: number;
  balance: {
    status: "ready" | "unconfigured" | "unavailable";
    balances: { currency: BillingCurrency; remaining: number }[];
  };
  today: {
    date: string;
    timeZone: "Asia/Shanghai";
    partial: boolean;
    pricedRequests: number;
    unpricedRequests: number;
    pricingDate: string;
    estimates: { currency: BillingCurrency; minimum: number; maximum: number }[];
  };
}

export function parseBillingSnapshot(value: unknown): BillingSnapshot {
  const root = record(value);
  const balance = record(root.balance);
  const today = record(root.today);
  if (root.billingVersion !== 1 || !timestamp(root.checkedAt)
    || !["ready", "unconfigured", "unavailable"].includes(String(balance.status))
    || today.timeZone !== "Asia/Shanghai" || typeof today.partial !== "boolean"
    || !date(today.date) || !date(today.pricingDate)
    || !count(today.pricedRequests) || !count(today.unpricedRequests)) throw new Error("invalid billing summary");
  const balances = currencies(balance.balances).map(entry => {
    if (!amount(entry.remaining)) throw new Error("invalid balance");
    return {currency: entry.currency as BillingCurrency, remaining: entry.remaining as number};
  });
  if ((balance.status === "ready") !== (balances.length > 0)) throw new Error("invalid balance status");
  const estimates = currencies(today.estimates).map(entry => {
    if (!amount(entry.minimum) || !amount(entry.maximum) || (entry.minimum as number) > (entry.maximum as number)) throw new Error("invalid estimate");
    return {currency: entry.currency as BillingCurrency, minimum: entry.minimum as number, maximum: entry.maximum as number};
  });
  return {
    billingVersion: 1, checkedAt: root.checkedAt as number,
    balance: {status: balance.status as BillingSnapshot["balance"]["status"], balances},
    today: {
      date: today.date as string, timeZone: "Asia/Shanghai", partial: today.partial,
      pricedRequests: today.pricedRequests as number, unpricedRequests: today.unpricedRequests as number,
      pricingDate: today.pricingDate as string, estimates,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid billing object");
  return value as Record<string, unknown>;
}
function currencies(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("invalid currencies");
  const entries = value.map(record);
  if (entries.some(entry => entry.currency !== "CNY" && entry.currency !== "USD")
    || new Set(entries.map(entry => entry.currency)).size !== entries.length) throw new Error("invalid currencies");
  return entries;
}
function amount(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000; }
function timestamp(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function date(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
