/** Read-only financial summary. Never includes credentials or session identity. */
export type BillingCurrency = "CNY" | "USD";
/** Allows the official account service's 30-second request to settle. */
export const BILLING_REQUEST_TIMEOUT_MS = 35_000;
export interface BillingSnapshot {
  billingVersion: 1;
  checkedAt: number;
  pricingPeriod?: "peak" | "off-peak" | "unknown";
  balance: {
    status: "ready" | "unconfigured" | "unavailable";
    source?: "deepseek-official" | "deepseek" | "deepseek-account";
    balances: { currency: BillingCurrency; remaining: number }[];
    bonusBalances?: { currency: BillingCurrency; remaining: number }[];
  };
  today: {
    scope?: "api-key" | "account";
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
  const balances = walletBalances(balance.balances);
  const account = balance.source === "deepseek-account";
  const bonusBalances = balance.bonusBalances === undefined ? undefined : walletBalances(balance.bonusBalances);
  if (account) {
    // An empty official wallet list is not evidence of a zero balance.
    if (balance.status !== "ready" && (balances.length || bonusBalances?.length)) throw new Error("invalid balance status");
    if (balance.status === "ready" && bonusBalances === undefined) throw new Error("missing bonus balances");
  } else if (bonusBalances !== undefined || (balance.status === "ready") !== (balances.length > 0)) throw new Error("invalid balance status");
  if (root.pricingPeriod !== undefined && !["peak","off-peak","unknown"].includes(String(root.pricingPeriod))) throw new Error("invalid pricing period");
  if (balance.source !== undefined && (!["deepseek-official","deepseek","deepseek-account"].includes(String(balance.source)) || balance.status === "unconfigured")) throw new Error("invalid balance source");
  if (today.scope !== undefined && today.scope !== "api-key" && today.scope !== "account") throw new Error("invalid estimate scope");
  const estimates = currencies(today.estimates).map(entry => {
    if (!amount(entry.minimum) || !amount(entry.maximum) || (entry.minimum as number) > (entry.maximum as number)) throw new Error("invalid estimate");
    return {currency: entry.currency as BillingCurrency, minimum: entry.minimum as number, maximum: entry.maximum as number};
  });
  // Account billing has no verified tariff in this contract. Never label API
  // estimates, an invented zero, or the API discount period as account charges.
  if (account !== (today.scope === "account") || (account && (estimates.length || today.pricedRequests !== 0
    || today.unpricedRequests !== 0 || today.partial !== true || root.pricingPeriod !== undefined))) throw new Error("invalid account estimate");
  return {
    billingVersion: 1, checkedAt: root.checkedAt as number,
    ...(root.pricingPeriod === undefined ? {} : {pricingPeriod: root.pricingPeriod as NonNullable<BillingSnapshot["pricingPeriod"]>}),
    balance: {status: balance.status as BillingSnapshot["balance"]["status"], balances,
      ...(bonusBalances === undefined ? {} : {bonusBalances}),
      ...(balance.source === undefined ? {} : {source: balance.source as NonNullable<BillingSnapshot["balance"]["source"]>})},
    today: {
      ...(today.scope === undefined ? {} : {scope: today.scope as "api-key" | "account"}),
      date: today.date as string, timeZone: "Asia/Shanghai", partial: today.partial,
      pricedRequests: today.pricedRequests as number, unpricedRequests: today.unpricedRequests as number,
      pricingDate: today.pricingDate as string, estimates,
    },
  };
}

function walletBalances(value: unknown): {currency: BillingCurrency; remaining: number}[] {
  return currencies(value).map(entry => {
    if (!signedAmount(entry.remaining)) throw new Error("invalid balance");
    return {currency: entry.currency as BillingCurrency, remaining: entry.remaining as number};
  });
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
function signedAmount(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000; }
function timestamp(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function date(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
