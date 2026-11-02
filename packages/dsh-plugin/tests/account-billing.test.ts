import {describe, expect, it, vi} from "vitest";
import {DeepSeekBilling} from "../src/billing.js";

const NOW = Date.parse("2026-11-02T08:00:00Z");
const ready = (balance = "109.89") => ({status: "ready", value: [{currency: "CNY", balance}],
  bonusWallets: [{currency: "CNY", balance: ".21"}], private: "PRIVATE response token"});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture(apiKey = false) {
  let now = NOW;
  let wake: (() => void) | undefined;
  let revision = 0, observed = -1;
  const ended = vi.fn();
  const account = {
    getState: vi.fn(async (): Promise<unknown> => ({status: "credential-stored", attempt: {authorizeUrl: "PRIVATE URL"}})),
    getBalance: vi.fn(async (_client: unknown): Promise<unknown> => ready()),
    resolveToken: vi.fn(), getPlatformSession: vi.fn(), getProfile: vi.fn(),
    watch: vi.fn(async function* (signal: AbortSignal) {
      const interrupt = () => wake?.(); signal.addEventListener("abort", interrupt);
      try {
        while (!signal.aborted) {
          if (revision !== observed) {observed = revision; yield {status: "credential-stored", private: "PRIVATE identity"};}
          else await new Promise<void>(resolve => {wake = resolve;});
        }
      } finally {signal.removeEventListener("abort", interrupt); ended();}
    }),
  };
  const credentials = {resolve: vi.fn(async () => ({value: "PRIVATE-api-key"})), readRecord: vi.fn()};
  const persistence = {list: vi.fn(async () => []), open: vi.fn()};
  const services: Record<string, unknown> = {deepseekAccount: account, credentials, sessionPersistence: persistence,
    settings: {get: (namespace: string) => apiKey && namespace === "llm-deepseek" ? {apiKeyEnv: "DEEPSEEK_API_KEY"} : undefined}};
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({is_available: true,
    balance_infos: [{currency: "USD", total_balance: "12.34"}]}), {headers: {"Content-Type": "application/json"}}));
  const source = new DeepSeekBilling({get: name => services[name]}, request, () => now);
  return {source, account, request, credentials, persistence, services, ended,
    advance: (ms: number) => {now += ms;},
    notify: async () => {revision++; wake?.(); await vi.waitFor(() => expect(observed).toBe(revision));},
  };
}

describe("DeepSeek account billing", () => {
  it("reads official recharge and bonus wallets with no key, personal profile, inference or history access", async () => {
    const f = fixture();
    try {
      const result = await f.source.read();
      expect(result.balance).toEqual({status: "ready", source: "deepseek-account",
        balances: [{currency: "CNY", remaining: 109.89, decimal: "109.89"}], bonusBalances: [{currency: "CNY", remaining: .21, decimal: ".21"}]});
      expect(result.today).toMatchObject({scope: "account", partial: true, estimates: [], pricedRequests: 0, unpricedRequests: 0});
      expect(result.pricingPeriod).toBeUndefined();
      expect(f.account.getBalance).toHaveBeenCalledExactlyOnceWith({version: expect.stringMatching(/^\d+\.\d+\.\d+/u),
        locale: Intl.DateTimeFormat().resolvedOptions().locale, timezoneOffsetSeconds: -new Date(NOW).getTimezoneOffset() * 60});
      expect(f.credentials.resolve).not.toHaveBeenCalled(); expect(f.credentials.readRecord).not.toHaveBeenCalled();
      expect(f.account.resolveToken).not.toHaveBeenCalled(); expect(f.account.getPlatformSession).not.toHaveBeenCalled();
      expect(f.account.getProfile).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
      expect(f.persistence.list).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    } finally {f.source.close();}
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledOnce());
  });
  it("prefers a signed-in account over an independently configured API key, and reuses a bounded cache", async () => {
    const f = fixture(true);
    try {
      const [first, second] = await Promise.all([f.source.read(), f.source.read()]);
      expect(first).toEqual(second); expect(first.balance.source).toBe("deepseek-account");
      f.advance(6000); await f.source.read(); expect(f.account.getBalance).toHaveBeenCalledOnce();
      f.advance(60_000); await f.source.read(); expect(f.account.getBalance).toHaveBeenCalledTimes(2);
      expect(f.credentials.resolve).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    } finally {f.source.close();}
  });
  it.each([null, {status: "failed"}, {status: "unknown"}])("does not turn an account failure into zero or another API account: %j", async outcome => {
    const f = fixture(true); f.account.getBalance.mockResolvedValue(outcome);
    try {
      expect((await f.source.read()).balance).toEqual({status: "unavailable", source: "deepseek-account", balances: []});
      expect(f.request).not.toHaveBeenCalled(); expect(f.credentials.resolve).not.toHaveBeenCalled();
    } finally {f.source.close();}
  });
  it("does not fall back on a failing or incompatible account service", async () => {
    const f = fixture(true);
    try {
      f.account.getState.mockRejectedValue(new Error("PRIVATE failure"));
      expect((await f.source.read()).balance.source).toBe("deepseek-account");
      f.services.deepseekAccount = {getState: null};
      expect((await f.source.read()).balance.status).toBe("unavailable");
      expect(f.request).not.toHaveBeenCalled(); expect(f.credentials.resolve).not.toHaveBeenCalled();
    } finally {f.source.close();}
  });
  it("uses the existing API route when the account is absent or signed out", async () => {
    const f = fixture(true);
    try {
      f.account.getState.mockResolvedValue({status: "signed-out"});
      expect((await f.source.read()).balance.source).toBe("deepseek-official");
      expect(f.account.getBalance).not.toHaveBeenCalled();
      delete f.services.deepseekAccount;
      expect((await f.source.read()).balance.source).toBe("deepseek-official");
      expect(f.request).toHaveBeenCalledTimes(2);
    } finally {f.source.close();}
  });
  it("refreshes equal-status account notifications and clears cached money on logout", async () => {
    const f = fixture(true);
    try {
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(109.89);
      f.account.getBalance.mockResolvedValue(ready("42")); await f.notify();
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(42);
      f.account.getState.mockResolvedValue({status: "signed-out"}); await f.notify();
      expect((await f.source.read()).balance.source).toBe("deepseek-official");
    } finally {f.source.close();}
  });
  it("replaces a pending account query immediately and discards its late result without clearing its successor", async () => {
    const f = fixture(); const old = deferred<unknown>(), next = deferred<unknown>();
    try {
      f.account.getBalance.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const oldResult = expect(f.source.read()).rejects.toThrow("billing unavailable");
      await vi.waitFor(() => expect(f.account.getBalance).toHaveBeenCalledOnce());
      await f.notify(); await oldResult;
      const newResult = f.source.read(); await vi.waitFor(() => expect(f.account.getBalance).toHaveBeenCalledTimes(2));
      old.resolve(ready("999")); await Promise.resolve();
      expect(f.source.read()).toBe(newResult);
      next.resolve(ready("42")); expect((await newResult).balance.balances[0]?.remaining).toBe(42);
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(42);
    } finally {f.source.close();}
  });
  it("never caches balances when an older account service cannot observe account changes", async () => {
    const f = fixture(); f.services.deepseekAccount = {getState: f.account.getState, getBalance: f.account.getBalance};
    try {
      await f.source.read(); f.account.getBalance.mockResolvedValue(ready("42"));
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(42);
      expect(f.account.getBalance).toHaveBeenCalledTimes(2);
    } finally {f.source.close();}
  });
  it("contains an unavailable account observer without caching its account data", async () => {
    const f = fixture();
    f.services.deepseekAccount = {getState: f.account.getState, getBalance: f.account.getBalance,
      watch: () => {throw new Error("PRIVATE observer failure");}};
    try {
      await f.source.read(); f.account.getBalance.mockResolvedValue(ready("42"));
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(42);
      expect(f.account.getBalance).toHaveBeenCalledTimes(2);
    } finally {f.source.close();}
  });
  it("cannot reuse an account wallet as API balance before a delayed sign-out notification", async () => {
    const f = fixture(true);
    try {
      await f.source.read(); f.advance(6000);
      f.account.getState.mockResolvedValue({status: "signed-out"});
      expect((await f.source.read()).balance).toEqual({status: "ready", source: "deepseek-official", balances: [{currency: "USD", remaining: 12.34}]});
    } finally {f.source.close();}
  });
  it("accepts decimal scientific notation, separate currencies, negative and empty wallet lists", async () => {
    const f = fixture();
    try {
      f.account.getBalance.mockResolvedValue({status: "ready", value: [{currency: "CNY", balance: "0E-16"}, {currency: "USD", balance: "-2.5e-1"}],
        bonusWallets: [{currency: "USD", balance: "5.0000000000000000"}]});
      expect((await f.source.read()).balance).toMatchObject({balances: [{currency: "CNY", remaining: 0, decimal: "0E-16"}, {currency: "USD", remaining: -.25, decimal: "-2.5e-1"}],
        bonusBalances: [{currency: "USD", remaining: 5, decimal: "5.0000000000000000"}]});
      f.account.getBalance.mockResolvedValue({status: "ready", value: [], bonusWallets: []}); await f.notify();
      expect((await f.source.read()).balance).toEqual({status: "ready", source: "deepseek-account", balances: [], bonusBalances: []});
    } finally {f.source.close();}
  });
  it("preserves exact account decimals when numeric projection rounds or underflows", async () => {
    const f = fixture();
    try {
      const exact = "109.899999999999999999999999999999999999";
      f.account.getBalance.mockResolvedValue({status: "ready", value: [{currency: "CNY", balance: exact}],
        bonusWallets: [{currency: "CNY", balance: "1e-999"}]});
      expect((await f.source.read()).balance).toEqual({status: "ready", source: "deepseek-account",
        balances: [{currency: "CNY", remaining: Number(exact), decimal: exact}],
        bonusBalances: [{currency: "CNY", remaining: 0, decimal: "1e-999"}]});
    } finally {f.source.close();}
  });
  it.each(["NaN", "Infinity", "1e999", "1000000001", "0x10", "1,000", " ", "1".repeat(129)])("rejects malformed or unbounded account money %s", async amount => {
    const f = fixture(); f.account.getBalance.mockResolvedValue(ready(amount));
    try {expect((await f.source.read()).balance.status).toBe("unavailable");}
    finally {f.source.close();}
  });
  it.each([
    {status: "ready", value: [{currency: "EUR", balance: "1"}], bonusWallets: []},
    {status: "ready", value: [{currency: "CNY", balance: "1"}, {currency: "CNY", balance: "2"}], bonusWallets: []},
    {status: "ready", value: [], bonusWallets: [{currency: "CNY", balance: 1}]},
    {status: "ready", value: []},
  ])("rejects incompatible wallet responses without leaking provider payloads", async response => {
    const f = fixture(); f.account.getBalance.mockResolvedValue(response);
    try {expect((await f.source.read()).balance.status).toBe("unavailable");}
    finally {f.source.close();}
  });
  it("bounds a non-cancellable account request and retries without awaiting its late completion", async () => {
    vi.useFakeTimers(); const f = fixture(); const late = deferred<unknown>();
    try {
      f.account.getBalance.mockReturnValueOnce(late.promise);
      const timeout = expect(f.source.read()).rejects.toThrow("billing unavailable");
      await vi.waitFor(() => expect(f.account.getBalance).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(32_000); await timeout;
      expect((await f.source.read()).balance.status).toBe("ready");
      late.resolve(ready("999")); await Promise.resolve();
      expect((await f.source.read()).balance.balances[0]?.remaining).toBe(109.89);
    } finally {f.source.close(); vi.useRealTimers();}
  });
  it("keeps the API timeout at eight seconds while an account service is signed out", async () => {
    vi.useFakeTimers(); const f = fixture(true);
    try {
      f.account.getState.mockResolvedValue({status: "signed-out"});
      f.request.mockImplementation(() => new Promise<Response>(() => {}));
      const timeout = expect(f.source.read()).rejects.toThrow("billing unavailable");
      await vi.advanceTimersByTimeAsync(8000); await timeout;
    } finally {f.source.close(); vi.useRealTimers();}
  });
  it("closes the watch and rejects pending requests even when the service ignores cancellation", async () => {
    const f = fixture(); const late = deferred<unknown>(); f.account.getBalance.mockReturnValue(late.promise);
    const pending = expect(f.source.read()).rejects.toThrow("billing unavailable");
    await vi.waitFor(() => expect(f.account.getBalance).toHaveBeenCalledOnce()); f.source.close(); await pending;
    late.resolve(ready()); await expect(f.source.read()).rejects.toThrow("billing unavailable");
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledOnce());
  });
});
