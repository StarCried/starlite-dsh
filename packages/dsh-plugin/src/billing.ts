import { parseBillingSnapshot, type BillingSnapshot } from "@starcried/starlite-dsh-protocol";
import {readFile} from "node:fs/promises";
import {deepSeekPricingPeriod} from "./pricing-period.js";

const PRICING_DATE = "2026-10-10";
const CURRENCIES = ["CNY", "USD"] as const;
// Official peak prices per million tokens, verified on PRICING_DATE.
// Off-peak is half. A range avoids pretending to know provider billing time
// at the boundary of tariff periods. Unknown model IDs never inherit a price.
const RATES: Record<string, readonly [number, number, number][]> = {
  "deepseek-flash": [[.04, 2, 8], [.006, .3, 1.2]],
  "deepseek-v4-flash": [[.04, 2, 8], [.006, .3, 1.2]],
  "deepseek-v4-flash-vision-exp": [[.04, 2, 8], [.006, .3, 1.2]],
  "deepseek-v4-pro": [[.30, 9, 27], [.044, 1.32, 3.96]],
};
const MAX_SESSIONS = 512;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 100_000;
const MAX_BALANCE_BYTES = 16_384;
const ACCOUNT_TIMEOUT_MS = 32_000;
const API_TIMEOUT_MS = 8000;
const UNAVAILABLE_ACCOUNT = Symbol("unavailable account service");

interface AccountClient {version: string; locale: string; timezoneOffsetSeconds: number;}
interface AccountService {
  getState(): Promise<unknown>;
  getBalance(client: AccountClient): Promise<unknown>;
  watch?(signal: AbortSignal): AsyncIterable<unknown>;
}

export interface BillingContext {
  get?(name: string): unknown;
}
interface Settings {
  get?(namespace: string): unknown;
  describe?(options: {redactSecrets: true}): unknown;
}
interface Credentials {
  resolve(reference: string): Promise<{value: string} | undefined>;
  readRecord(key: string): Promise<unknown>;
}
export interface BillingPersistence {
  list(options: {signal: AbortSignal}): Promise<readonly {
    header: {id: string}; revision: unknown; sizeBytes?: number;
  }[]>;
  open(id: string, access: "read", options: {signal: AbortSignal}): Promise<{
    inheritedEventCount: number;
    read(offset: number, length: number, options: {signal: AbortSignal}): Promise<{events: readonly unknown[]}>;
    close(): Promise<void>;
  }>;
}
export interface BillingSource { read(): Promise<BillingSnapshot>; close(): void; }
interface SessionUsage { priced: number; unpriced: number; maximums: number[]; }
interface OfficialRoute { provider: "deepseek-official" | "deepseek"; profile: Record<string, unknown>; }

/** Reads existing DSH services only; never writes credentials or session files. */
export class DeepSeekBilling implements BillingSource {
  readonly #context: BillingContext;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, {revision: unknown; date: string; usage: SessionUsage}>();
  #balance: {at: number; value: BillingSnapshot["balance"]} | undefined;
  #snapshot: BillingSnapshot | undefined;
  #pending: Promise<BillingSnapshot> | undefined;
  #abort: AbortController | undefined;
  #closed = false;
  #generation = 0;
  #accountValue: unknown;
  #account: AccountService | undefined;
  #accountWatch: AbortController | undefined;
  #accountWatchReady: Promise<void> | undefined;
  #accountWatchHealthy = false;
  #version: Promise<string> | undefined;

  constructor(context: BillingContext, fetchImplementation: typeof fetch = fetch, now: () => number = Date.now) {
    this.#context = context; this.#fetch = fetchImplementation; this.#now = now;
  }
  invalidate(accountChanged = false): void {
    ++this.#generation; this.#snapshot = undefined;
    if (accountChanged) {
      this.#balance = undefined; this.#cache.clear(); this.#abort?.abort();
      // A replacement account must not wait for an old, non-cancellable Host call.
      this.#pending = undefined; this.#abort = undefined;
    }
  }
  close(): void {
    this.#closed = true; this.#accountWatch?.abort(); this.invalidate(true);
  }
  read(): Promise<BillingSnapshot> {
    if (this.#closed) return Promise.reject(new Error("billing unavailable"));
    this.#bindAccount();
    const now = this.#now();
    if ((!this.#accountValue || this.#accountWatchHealthy) && this.#snapshot
      && this.#snapshot.today.date === billingDate(now) && now - this.#snapshot.checkedAt < 5000) return Promise.resolve(this.#snapshot);
    if (this.#pending) return this.#pending;
    // describe() can announce its first live snapshot. Read it before opening
    // this request so its own settings notification cannot abort the query.
    const routes = officialRoutes(this.#context);
    const generation = this.#generation;
    const abort = new AbortController(); this.#abort = abort;
    const timer = setTimeout(() => abort.abort(), this.#accountValue ? ACCOUNT_TIMEOUT_MS : API_TIMEOUT_MS); timer.unref();
    const pending = abortable(this.#query(now, abort.signal, routes), abort.signal).then(snapshot => {
      if (!this.#closed && generation === this.#generation) this.#snapshot = snapshot;
      return snapshot;
    }).finally(() => {
      clearTimeout(timer);
      if (this.#pending === pending) {this.#pending = undefined; this.#abort = undefined;}
    });
    this.#pending = pending;
    return pending;
  }
  async #query(now: number, signal: AbortSignal, routes: readonly OfficialRoute[]): Promise<BillingSnapshot> {
    const account = this.#account;
    if (this.#accountValue && !account) return accountSnapshot(now, {status: "unavailable", source: "deepseek-account", balances: []});
    if (account) {
      await abortable(this.#accountWatchReady ?? Promise.resolve(), signal);
      let state: Record<string, unknown> | undefined;
      try {state = record(await abortable(account.getState(), signal));}
      catch {if (signal.aborted) throw new Error("billing unavailable");}
      if (state?.status !== "signed-out") {
        const balance = state?.status === "credential-stored"
          ? await this.#readAccountBalance(account, now, signal)
          : {status: "unavailable" as const, source: "deepseek-account" as const, balances: []};
        if (signal.aborted || this.#closed) throw new Error("billing unavailable");
        return accountSnapshot(now, balance);
      }
    }
    // A signed-out account can use an independently configured API key, but
    // slow API calls retain their existing eight-second limit.
    const apiAbort = new AbortController();
    const apiSignal = AbortSignal.any([signal, apiAbort.signal]);
    const timer = setTimeout(() => apiAbort.abort(), API_TIMEOUT_MS); timer.unref();
    try {return await abortable(this.#queryApi(now, apiSignal, routes), apiSignal);}
    finally {clearTimeout(timer);}
  }
  #bindAccount(): void {
    let value: unknown;
    try {value = this.#context.get?.("deepseekAccount") ?? undefined;}
    catch {value = UNAVAILABLE_ACCOUNT;}
    if (value === this.#accountValue) return;
    this.invalidate(true);
    this.#accountWatch?.abort(); this.#accountWatch = undefined;
    this.#accountWatchHealthy = false; this.#accountWatchReady = undefined;
    this.#accountValue = value;
    const candidate = record(value);
    this.#account = candidate && typeof candidate.getState === "function" && typeof candidate.getBalance === "function"
      ? candidate as unknown as AccountService : undefined;
    if (!this.#account || typeof this.#account.watch !== "function") return;
    const account = this.#account;
    const watch = new AbortController(); this.#accountWatch = watch;
    let primed!: () => void;
    this.#accountWatchReady = new Promise<void>(resolve => {primed = resolve;});
    void (async () => {
      let first = true;
      try {
        for await (const _state of account.watch!(watch.signal)) {
          if (watch.signal.aborted || this.#accountWatch !== watch) break;
          if (first) {first = false; this.#accountWatchHealthy = true; primed();}
          // Every notification invalidates, even when both accounts report
          // credential-stored. No identity or login-attempt payload is retained.
          else this.invalidate(true);
        }
      } catch { /* Optional account observation must not stop DSH. */ }
      finally {
        primed();
        if (this.#accountWatch === watch) {
          this.#accountWatchHealthy = false;
          if (!watch.signal.aborted && !first) this.invalidate(true);
        }
      }
    })();
  }
  async #readAccountBalance(account: AccountService, now: number, signal: AbortSignal): Promise<BillingSnapshot["balance"]> {
    if (this.#accountWatchHealthy && this.#balance?.value.source === "deepseek-account" && now - this.#balance.at < 60_000) return this.#balance.value;
    let value: BillingSnapshot["balance"] = {status: "unavailable", source: "deepseek-account", balances: []};
    try {
      this.#version ??= readFile(new URL("../package.json", import.meta.url), "utf8").then(text => {
        const version = record(JSON.parse(text))?.version;
        if (typeof version !== "string" || version.length > 64 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) throw new Error("invalid plugin version");
        return version;
      });
      const client = {version: await abortable(this.#version, signal), locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezoneOffsetSeconds: -new Date(now).getTimezoneOffset() * 60};
      const raw = record(await abortable(account.getBalance(client), signal));
      if (raw?.status === "ready") value = {status: "ready", source: "deepseek-account",
        balances: accountWallets(raw.value), bonusBalances: accountWallets(raw.bonusWallets)};
    } catch { /* Host failures and rejected grants never become zero balances. */ }
    if (!signal.aborted && !this.#closed && this.#accountWatchHealthy && account === this.#account) this.#balance = {at: now, value};
    return value;
  }
  async #queryApi(now: number, signal: AbortSignal, routes: readonly OfficialRoute[]): Promise<BillingSnapshot> {
    const date = billingDate(now);
    const official = routes.length > 0;
    const balancePromise = official ? this.#readBalance(routes, now, signal) : Promise.resolve({status: "unconfigured" as const, balances: []});
    const today: BillingSnapshot["today"] = {
      scope: "api-key", date, timeZone: "Asia/Shanghai", partial: !official, pricedRequests: 0, unpricedRequests: 0,
      pricingDate: PRICING_DATE, estimates: CURRENCIES.map(currency => ({currency, minimum: 0, maximum: 0})),
    };
    const persistence = this.#context.get?.("sessionPersistence") as BillingPersistence | undefined;
    if (!official || !persistence || typeof persistence.list !== "function" || typeof persistence.open !== "function") today.partial = true;
    else {
      try {
        const sessions = await persistence.list({signal});
        if (sessions.length > MAX_SESSIONS) today.partial = true;
        const seen = new Set<string>();
        for (const session of sessions.slice(0, MAX_SESSIONS)) {
          if (signal.aborted) {today.partial = true; break;}
          const id = session.header.id; seen.add(id);
          if (session.sizeBytes !== undefined && session.sizeBytes > MAX_SESSION_BYTES) {today.partial = true; continue;}
          let usage = this.#cache.get(id);
          if (!usage || usage.date !== date || usage.revision !== session.revision) {
            let handle: Awaited<ReturnType<BillingPersistence["open"]>> | undefined;
            try {
              handle = await persistence.open(id, "read", {signal});
              const {events} = await handle.read(0, MAX_EVENTS + 1, {signal});
              if (events.length > MAX_EVENTS || !Number.isSafeInteger(handle.inheritedEventCount) || handle.inheritedEventCount < 0 || handle.inheritedEventCount > events.length) {today.partial = true; continue;}
              usage = {revision: session.revision, date, usage: foldDailyUsage(events, handle.inheritedEventCount, date, routes.map(route => route.provider))};
              if (signal.aborted) throw new Error("billing unavailable");
              this.#cache.set(id, usage);
            } catch {today.partial = true; continue;}
            finally {await handle?.close().catch(() => {today.partial = true;});}
          }
          today.pricedRequests += usage.usage.priced; today.unpricedRequests += usage.usage.unpriced;
          today.estimates.forEach((estimate, i) => {estimate.maximum += usage.usage.maximums[i] ?? 0; estimate.minimum = estimate.maximum / 2;});
        }
        for (const id of this.#cache.keys()) if (!seen.has(id)) this.#cache.delete(id);
      } catch {today.partial = true;}
    }
    const balance = await balancePromise;
    if (signal.aborted || this.#closed) throw new Error("billing unavailable");
    return parseBillingSnapshot({billingVersion: 1, checkedAt: now, pricingPeriod: deepSeekPricingPeriod(now), balance, today});
  }
  async #readBalance(routes: readonly OfficialRoute[], now: number, signal: AbortSignal): Promise<BillingSnapshot["balance"]> {
    if (this.#balance && this.#balance.value.source !== "deepseek-account" && now - this.#balance.at < 60_000) return this.#balance.value;
    let value: BillingSnapshot["balance"];
    let source: BillingSnapshot["balance"]["source"];
    try {
      // Prefer DSH's native route, then the explicitly configured pi-ai route.
      // A missing native key must not hide an existing pi-ai credential.
      let key: string | undefined;
      for (const route of routes) {
        key = await resolveKey(this.#context, route);
        if (key) {source = route.provider;break;}
      }
      if (!key) value = {status: "unconfigured", balances: []};
      else {
        const request = this.#fetch;
        const response = await request("https://api.deepseek.com/user/balance", {
          method: "GET", headers: {Authorization: `Bearer ${key}`}, redirect: "error", signal,
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) {
          await response.body?.cancel(); throw new Error("balance unavailable");
        }
        const reader = response.body.getReader(); let bytes = 0; let json = "";
        const decoder = new TextDecoder();
        try {
          while (true) {
            const {done, value: chunk} = await reader.read(); if (done) break;
            bytes += chunk.byteLength; if (bytes > MAX_BALANCE_BYTES) throw new Error("balance too large");
            json += decoder.decode(chunk, {stream: true});
          }
          json += decoder.decode();
        } finally {await reader.cancel().catch(() => undefined);}
        const raw = record(JSON.parse(json));
        if (typeof raw?.is_available !== "boolean" || !Array.isArray(raw.balance_infos) || raw.balance_infos.length < 1 || raw.balance_infos.length > 2) throw new Error("invalid balance");
        const balances = raw.balance_infos.map(item => {
          const entry = record(item);
          if (!entry || !["CNY", "USD"].includes(String(entry.currency)) || typeof entry.total_balance !== "string" || !/^-?\d{1,9}(\.\d{1,8})?$/u.test(entry.total_balance)) throw new Error("invalid balance");
          return {currency: entry.currency as "CNY" | "USD", remaining: Number(entry.total_balance)};
        });
        if (new Set(balances.map(item => item.currency)).size !== balances.length) throw new Error("duplicate currency");
        value = {status: "ready", balances, ...(source ? {source} : {})};
      }
    } catch {value = {status: "unavailable", balances: [], ...(source ? {source} : {})};}
    if (!signal.aborted && !this.#closed) this.#balance = {at: now, value};
    return value;
  }
}

function accountSnapshot(now: number, balance: BillingSnapshot["balance"]): BillingSnapshot {
  return parseBillingSnapshot({billingVersion: 1, checkedAt: now, balance,
    today: {scope: "account", date: billingDate(now), timeZone: "Asia/Shanghai", partial: true,
      pricedRequests: 0, unpricedRequests: 0, pricingDate: PRICING_DATE, estimates: []}});
}
function accountWallets(value: unknown): BillingSnapshot["balance"]["balances"] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("invalid account wallets");
  const wallets = value.map(item => {
    const entry = record(item);
    if (!entry || (entry.currency !== "CNY" && entry.currency !== "USD") || typeof entry.balance !== "string"
      || entry.balance.length > 128 || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(entry.balance)) throw new Error("invalid account wallet");
    const remaining = Number(entry.balance);
    if (!Number.isFinite(remaining) || Math.abs(remaining) > 1_000_000_000) throw new Error("invalid account amount");
    return {currency: entry.currency as "CNY" | "USD", remaining};
  });
  if (new Set(wallets.map(wallet => wallet.currency)).size !== wallets.length) throw new Error("duplicate account currency");
  return wallets;
}
/** Host account methods do not take caller signals. Stop waiting without letting
 * a late fulfillment populate the cache or an old finally clear a new request. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("billing unavailable"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, {once: true});
    promise.then(value => {
      if (signal.aborted) abort(); else resolve(value);
    }, () => reject(new Error("billing unavailable"))).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function billingDate(time: number): string {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function officialProfile(value: unknown): boolean {
  const profile = record(value); if (!profile) return false;
  if (record(profile.headers) && Object.keys(record(profile.headers)!).some(key => /^(authorization|x-api-key|api-key)$/iu.test(key))) return false;
  if (Array.isArray(profile.models) && profile.models.some(model => {
    const override = record(model)?.baseURL;
    return override !== undefined && !officialEndpoint(override);
  })) return false;
  return profile.baseURL === undefined || officialEndpoint(profile.baseURL); // Built-in deepseek route defaults to official.
}
function officialEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash
      && ["/", "/v1", "/v1/", "/anthropic", "/anthropic/"].includes(url.pathname);
  } catch {return false;}
}
function officialRoutes(context: BillingContext): OfficialRoute[] {
  const settings = context.get?.("settings") as Settings | undefined;
  if (!settings) return [];
  try {
    let candidates: OfficialRoute[];
    if (typeof settings.get === "function") {
      const native = record(settings.get("llm-deepseek"));
      const pi = record(record(record(settings.get("llm-pi-ai"))?.providers)?.deepseek);
      candidates = [...(native ? [{provider: "deepseek-official" as const, profile: native}] : []), ...(pi ? [{provider: "deepseek" as const, profile: pi}] : [])];
    } else {
      const llm = context.get?.("llm") as {listConfigurableProviders?(): unknown} | undefined;
      if (typeof settings.describe !== "function" || typeof llm?.listConfigurableProviders !== "function") return [];
      const directory = llm.listConfigurableProviders();
      const descriptors = settings.describe({redactSecrets: true});
      if (!Array.isArray(directory) || !Array.isArray(descriptors)) return [];
      candidates = [];
      // Account login is a different credential type, never an API-key route.
      for (const provider of ["deepseek-official", "deepseek"] as const) {
        const entries = directory.map(record).filter(entry => entry?.provider === provider);
        if (entries.length !== 1) continue;
        const entry = entries[0]!;
        if (typeof entry.settingsNs !== "string" || !entry.settingsNs || !Array.isArray(entry.settingsPath) || entry.settingsPath.length > 8
          || entry.settingsPath.some(segment => typeof segment !== "string" || !segment || ["__proto__", "prototype", "constructor"].includes(segment))) continue;
        const rows = descriptors.map(record).filter(row => row?.ns === entry.settingsNs);
        if (rows.length !== 1) continue;
        let profile = record(rows[0]?.value);
        for (const segment of entry.settingsPath as string[]) profile = profile && Object.hasOwn(profile, segment) ? record(profile[segment]) : undefined;
        if (profile) candidates.push({provider, profile});
      }
    }
    return candidates.filter(route => {
      if (route.provider === "deepseek") return officialProfile(route.profile);
      const environment = context.get?.("launchEnvironment") as {get(name: string): {value: string} | undefined} | undefined;
      // Use the same trusted endpoint precedence as the native API-key adapter.
      const baseURL = route.profile.baseURL ?? (environment ? environment.get("DEEPSEEK_BASE_URL")?.value : process.env.DEEPSEEK_BASE_URL)
        ?? (typeof settings.get === "function" ? "https://api.deepseek.com" : "https://api.deepseek.com/anthropic");
      return officialProfile({...route.profile, baseURL});
    });
  } catch {
    return [];
  }
}
async function resolveKey(context: BillingContext, route: OfficialRoute): Promise<string | undefined> {
  const credentials = context.get?.("credentials") as Credentials | undefined;
  if (!credentials) return undefined;
  const reference = route.profile.apiKeyEnv ?? (route.provider === "deepseek-official" ? "DEEPSEEK_API_KEY" : undefined);
  let value: unknown;
  if (reference !== undefined) {
    if (typeof reference !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) return undefined;
    value = (await credentials.resolve(reference))?.value;
  } else {
    const stored = record(await credentials.readRecord("llm-pi-ai/deepseek"));
    if (stored?.kind === "api-key") value = stored.key ?? record(stored.env)?.DEEPSEEK_API_KEY;
    value ??= (await credentials.resolve("DEEPSEEK_API_KEY"))?.value;
  }
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[!-~]+$/u.test(value) ? value : undefined;
}

/** Last settlement wins per attempt; retry-started opens a separate billable slot. */
export function foldDailyUsage(events: readonly unknown[], inherited: number, date: string, providers: readonly string[] = ["deepseek"]): SessionUsage {
  const result: SessionUsage = {priced: 0, unpriced: 0, maximums: [0, 0]};
  let header: Record<string, unknown> | undefined;
  let last: {turn: unknown; step: unknown; sample: Record<string, unknown> | undefined; route: Record<string, unknown> | undefined; time: number} | undefined;
  const flush = () => {
    if (!last || billingDate(last.time) !== date || (typeof last.route?.provider === "string" && !providers.includes(last.route.provider))) {last = undefined; return;}
    const rates = typeof last.route?.model === "string" && typeof last.route.provider === "string" && providers.includes(last.route.provider) && Object.hasOwn(RATES,last.route.model) ? RATES[last.route.model] : undefined;
    const sample = normalizeUsage(last.sample);
    if (!rates || !sample) result.unpriced++;
    else {
      result.priced++;
      rates.forEach((rate, i) => {result.maximums[i] = (result.maximums[i] ?? 0) + (rate[0] * sample.hit + rate[1] * sample.input + rate[2] * sample.output) / 1_000_000;});
    }
    last = undefined;
  };
  for (let i = 0; i < events.length; i++) {
    const event = record(events[i]); const data = record(event?.data);
    if (event?.type === "request/header") header = record(record(data?.header)?.config);
    if (i < inherited) continue;
    if (event?.type === "llm/retry-started") {flush(); continue;}
    if (event?.type !== "assistant/message" && event?.type !== "assistant/attempt") continue;
    if (!data || !count(data.turn) || !count(data.step) || !count(event.time)) continue;
    if (last && (last.turn !== data.turn || last.step !== data.step)) flush();
    let sample = record(data.usage);
    if (!sample && Array.isArray(data.stream)) {
      for (const item of data.stream) {
        const chunk = record(record(item)?.chunk);
        if (chunk?.type === "usage") sample = record(chunk.usage);
      }
    }
    const source = record(record(data.message)?.source);
    last = {turn: data.turn, step: data.step, sample: sample ?? last?.sample, route: source ?? header ?? last?.route, time: event.time as number};
  }
  flush(); return result;
}
function normalizeUsage(sample: Record<string, unknown> | undefined): {input: number; hit: number; output: number} | undefined {
  if (!sample || !count(sample.inputTokens) || !count(sample.outputTokens)
    || !count(sample.cacheReadTokens) || (sample.cacheWriteTokens !== undefined && sample.cacheWriteTokens !== 0)) return undefined;
  const input = sample.inputTokens as number, output = sample.outputTokens as number, hit = sample.cacheReadTokens as number;
  const total = input + output + hit;
  if (!count(total) || (sample.totalTokens !== undefined && sample.totalTokens !== total)
    || (sample.reasoningTokens !== undefined && (!count(sample.reasoningTokens) || (sample.reasoningTokens as number) > output))) return undefined;
  return {input, output, hit};
}
function count(value: unknown): boolean {return Number.isSafeInteger(value) && (value as number) >= 0;}
function record(value: unknown): Record<string, unknown> | undefined {return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;}
