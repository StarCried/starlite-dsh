import { describe, expect, it, vi } from "vitest";
import { DeepSeekBilling, billingDate, foldDailyUsage, officialProfile, type BillingPersistence } from "../src/billing.js";

const NOW = Date.parse("2026-10-08T08:00:00Z");
const usage = {inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000, cacheWriteTokens: 0, totalTokens: 1_300_000, reasoningTokens: 50_000};
const header = (provider = "deepseek", model = "deepseek-flash") => ({type: "request/header", data: {header: {config: {provider, model}}}});
const message = (step = 1, sample: unknown = usage, time = NOW) => ({type: "assistant/message",time,
  data: {turn: 1, step, usage: sample, message: {source: {provider: "deepseek", model: "deepseek-flash"}, content: [{type:"text", text:"PRIVATE output"}]}}});
const balanceResponse = () => new Response(JSON.stringify({is_available: true, balance_infos: [{currency: "CNY", total_balance: "123.45", granted_balance: "0", topped_up_balance: "123.45"}]}), {headers:{"Content-Type":"application/json"}});
function fixture(events: readonly unknown[] = [header(), message()], inherited = 0) {
  let revision = 1;
  const close = vi.fn(async () => {});
  const read = vi.fn(async () => ({events}));
  const persistence: BillingPersistence = {list: vi.fn(async () => [{header:{id:"PRIVATE id"}, revision, sizeBytes:1000}]),
    open: vi.fn(async () => ({inheritedEventCount: inherited, read, close}))};
  const settings = {get: vi.fn((namespace: string): unknown => namespace === "llm-pi-ai" ? {providers:{deepseek:{apiKeyEnv:"DEEPSEEK_API_KEY"}}} : undefined)};
  const credentials = {resolve:vi.fn(async (): Promise<{value:string} | undefined> => ({value:"PRIVATE-key"})),readRecord:vi.fn(async (): Promise<unknown> => undefined)};
  const context = {get: (name: string) => ({settings,credentials,sessionPersistence:persistence} as Record<string,unknown>)[name]};
  const request = vi.fn<typeof fetch>(async () => balanceResponse());
  let now = NOW;
  const source = new DeepSeekBilling(context, request, () => now);
  return {source, context, request, credentials, settings, persistence, close, read,
    next: () => {now += 6000;}, revise: () => {revision++;}};
}

function directoryFixture(descriptors: unknown[], entries: unknown[]) {
  const f = fixture([]); f.source.close();
  const describe = vi.fn(() => descriptors), listConfigurableProviders = vi.fn(() => entries);
  const context = {get:(name:string) => name === "settings" ? {describe} : name === "llm" ? {listConfigurableProviders} : f.context.get(name)};
  return {...f, describe, listConfigurableProviders, source:new DeepSeekBilling(context,f.request,()=>NOW)};
}

describe("official DeepSeek billing", () => {
  it("reads the 0.2 API-key provider's redacted live descriptor through its declared custom namespace", async () => {
    const f = directoryFixture([{ns:"custom-native",value:{apiKeyEnv:"CUSTOM_DEEPSEEK_KEY",baseURL:"https://api.deepseek.com/anthropic"}}],
      [{provider:"deepseek-official",settingsNs:"custom-native",settingsPath:[]}]);
    const result = await f.source.read();
    expect(result.balance.status).toBe("ready");expect(result.balance.source).toBe("deepseek-official");
    expect(f.describe).toHaveBeenCalledExactlyOnceWith({redactSecrets:true});
    expect(f.credentials.resolve).toHaveBeenCalledExactlyOnceWith("CUSTOM_DEEPSEEK_KEY");
    expect(f.credentials.readRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");f.source.close();
  });
  it("keeps native API-key priority and the stored pi-ai route when 0.2 uses custom entry ids", async () => {
    const f = directoryFixture([{ns:"native",value:{}},{ns:"third-party",value:{providers:{deepseek:{}}}}], [
      {provider:"deepseek",settingsNs:"third-party",settingsPath:["providers","deepseek"]},
      {provider:"deepseek-official",settingsNs:"native",settingsPath:[]},
    ]);
    expect((await f.source.read()).balance.source).toBe("deepseek-official");
    f.credentials.resolve.mockResolvedValue(undefined);f.credentials.readRecord.mockResolvedValue({kind:"api-key",key:"PRIVATE-stored-key"});
    f.source.invalidate(true);
    expect((await f.source.read()).balance.source).toBe("deepseek");
    expect(f.credentials.readRecord).toHaveBeenCalledExactlyOnceWith("llm-pi-ai/deepseek");f.source.close();
  });
  it("does not read or reuse a DeepSeek account-login credential as an API key", async () => {
    const f = directoryFixture([{ns:"account",value:{apiKeyEnv:"ACCOUNT_LOGIN_TOKEN",baseURL:"https://api.deepseek.com/anthropic"}}],
      [{provider:"deepseek-account",settingsNs:"account",settingsPath:[]}]);
    expect((await f.source.read()).balance.status).toBe("unconfigured");
    expect(f.credentials.resolve).not.toHaveBeenCalled();expect(f.credentials.readRecord).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();f.source.close();
  });
  it.each([
    {descriptors:[{ns:"native",value:{}}],entries:[{provider:"deepseek-official",settingsNs:"native",settingsPath:[]},{provider:"deepseek-official",settingsNs:"other",settingsPath:[]}]},
    {descriptors:[{ns:"native",value:{}},{ns:"native",value:{}}],entries:[{provider:"deepseek-official",settingsNs:"native",settingsPath:[]}]},
    {descriptors:[{ns:"native",value:{}}],entries:[{provider:"deepseek-official",settingsNs:"native",settingsPath:["__proto__"]}]},
    {descriptors:[{ns:"native",value:{}}],entries:[{provider:"deepseek-official",settingsNs:"missing",settingsPath:[]}]},
    {descriptors:[{ns:"native",value:{baseURL:"https://gateway.invalid"}}],entries:[{provider:"deepseek-official",settingsNs:"native",settingsPath:[]}]},
  ])("rejects ambiguous, unsafe or unofficial 0.2 profile locations before reading a secret: %j", async ({descriptors,entries}) => {
    const f = directoryFixture(descriptors,entries);
    expect((await f.source.read()).balance.status).toBe("unconfigured");
    expect(f.credentials.resolve).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();f.source.close();
  });
  it("contains an unavailable 0.2 settings descriptor service", async () => {
    const f = directoryFixture([],[]);f.describe.mockImplementation(()=>{throw new Error("PRIVATE settings failure")});
    expect((await f.source.read()).balance.status).toBe("unconfigured");expect(f.credentials.resolve).not.toHaveBeenCalled();f.source.close();
  });
  it("uses the shipped native route and its credential without a pi-ai provider profile", async () => {
    const nativeMessage = {...message(),data:{...message().data,message:{source:{provider:"deepseek-official",model:"deepseek-flash"}}}};
    const f = fixture([header("deepseek-official"),nativeMessage]);
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? {apiKeyEnv:"DEEPSEEK_API_KEY"} : {providers:{}});
    const result = await f.source.read();
    expect(result.balance.status).toBe("ready");
    expect(result.balance.source).toBe("deepseek-official");
    expect(result.pricingPeriod).toBe("peak");
    expect(result.today.pricedRequests).toBe(1);
    expect(result.today.estimates[0]?.maximum).toBeCloseTo(2.808);
    expect(f.credentials.resolve).toHaveBeenCalledExactlyOnceWith("DEEPSEEK_API_KEY");
    expect(f.credentials.readRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    f.source.close();
  });
  it("uses native custom references and refreshes a missing key immediately after a credential update", async () => {
    const f = fixture([]);
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? {apiKeyEnv:"CUSTOM_DEEPSEEK_KEY",baseURL:"https://api.deepseek.com/v1"} : undefined);
    f.credentials.resolve.mockResolvedValueOnce(undefined);
    expect((await f.source.read()).balance.status).toBe("unconfigured");
    expect(f.request).not.toHaveBeenCalled();
    f.source.invalidate(true);
    expect((await f.source.read()).balance.status).toBe("ready");
    expect(f.credentials.resolve).toHaveBeenNthCalledWith(2,"CUSTOM_DEEPSEEK_KEY");
    expect(f.credentials.readRecord).not.toHaveBeenCalled();
    f.source.close();
  });
  it.each([
    {profile:{baseURL:"https://gateway.invalid"},environment:undefined,ready:false},
    {profile:{},environment:"https://gateway.invalid",ready:false},
    {profile:{baseURL:"https://api.deepseek.com"},environment:"https://gateway.invalid",ready:true},
    {profile:{},environment:"https://api.deepseek.com/v1",ready:true},
  ])("validates the effective native endpoint before reading credentials: %j", async ({profile,environment,ready}) => {
    const f = fixture();
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? profile : undefined);
    const context = {get:(name:string) => name === "launchEnvironment" ? {get:() => environment === undefined ? undefined : {value:environment}} : f.context.get(name)};
    const source = new DeepSeekBilling(context,f.request,()=>NOW);
    const result = await source.read();
    expect(result.balance.status).toBe(ready ? "ready" : "unconfigured");
    expect(f.credentials.resolve).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(f.request).toHaveBeenCalledTimes(ready ? 1 : 0);
    source.close();f.source.close();
  });
  it("only prices providers whose current endpoints are official, including native durable attempts", async () => {
    const nativeMessage = {...message(),data:{...message().data,message:{source:{provider:"deepseek-official",model:"deepseek-flash"}}}};
    const events = [header(),message(),header("deepseek-official"),{type:"llm/retry-started"},
      {type:"assistant/attempt",time:NOW,data:{turn:1,step:2,stream:[{chunk:{type:"usage",usage}}]}},
      {...nativeMessage,data:{...nativeMessage.data,step:3}}];
    const f = fixture(events);
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? {baseURL:"https://api.deepseek.com"} : {providers:{deepseek:{baseURL:"https://gateway.invalid"}}});
    expect((await f.source.read()).today.pricedRequests).toBe(2);
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? {baseURL:"https://gateway.invalid"} : {providers:{deepseek:{}}});
    f.source.invalidate(true);
    expect((await f.source.read()).today.pricedRequests).toBe(1);
    f.source.close();
  });
  it("preserves the existing stored pi-ai credential when the native route has no key", async () => {
    const f = fixture();
    f.settings.get.mockImplementation(namespace => namespace === "llm-deepseek" ? {} : {providers:{deepseek:{}}});
    f.credentials.resolve.mockResolvedValue(undefined);
    f.credentials.readRecord.mockResolvedValue({kind:"api-key",key:"PRIVATE-stored-key"});
    expect((await f.source.read()).balance.status).toBe("ready");
    expect(f.request).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({headers:{Authorization:"Bearer PRIVATE-stored-key"}}));
    expect(f.credentials.readRecord).toHaveBeenCalledExactlyOnceWith("llm-pi-ai/deepseek");
    f.source.close();
  });
  it("counts cache/output once, replacements once, retries and simultaneous sessions independently", async () => {
    const events = [header(), message(), message(), {type:"llm/retry-started"}, message(), message(2)];
    const fold = foldDailyUsage(events,0,"2026-10-08");
    expect(fold.priced).toBe(3);
    expect(fold.maximums[0]).toBeCloseTo(3 * (2 + .8 + .008));
    const f = fixture(events);
    vi.mocked(f.persistence.list).mockResolvedValue([
      {header:{id:"PRIVATE first"},revision:1}, {header:{id:"PRIVATE second"},revision:1},
    ]);
    const result = await f.source.read();
    expect(result.today.pricedRequests).toBe(6);
    expect(result.today.estimates[0]?.minimum).toBeCloseTo(3 * 2.808);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.persistence.open).toHaveBeenCalledWith("PRIVATE first","read",expect.any(Object));
    f.source.close();
  });
  it("excludes fork-inherited usage and previous dates, and keeps unpriced attempts explicit", () => {
    const events = [header(), message(), message(2), message(3,usage,NOW-86400000),
      {type:"assistant/attempt",time:NOW,data:{turn:1,step:4,stream:[{chunk:{type:"usage",usage}}]}},
      {type:"assistant/attempt",time:NOW,data:{turn:1,step:5,stream:[]}},
      message(6,{...usage,cacheReadTokens:undefined}), message(7,{...usage,totalTokens:1}),
      {...message(8),data:{...message(8).data,message:{source:{provider:"deepseek",model:"unknown"}}}},
      header("other","other"), {type:"assistant/attempt",time:NOW,data:{turn:1,step:9,stream:[]}},
    ];
    const result = foldDailyUsage(events,2,"2026-10-08");
    expect(result.priced).toBe(2);
    expect(result.unpriced).toBe(4);
    expect(billingDate(Date.parse("2026-10-07T16:00:00Z"))).toBe("2026-10-08");
  });
  it("rebuilds today from existing stored records after restarting and caches only numeric folds", async () => {
    const f = fixture();
    const [a,b] = await Promise.all([f.source.read(),f.source.read()]);
    expect(a).toEqual(b); expect(f.request).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
    f.next(); await f.source.read(); expect(f.read).toHaveBeenCalledTimes(1);
    f.revise(); f.source.invalidate(); await f.source.read(); expect(f.read).toHaveBeenCalledTimes(2);
    f.source.close();
    const restarted = new DeepSeekBilling(f.context,f.request,()=>NOW);
    expect((await restarted.read()).today.pricedRequests).toBe(1); restarted.close();
  });
  it("resolves keys only on demand and keeps credential changes, errors and redirects out of the wire", async () => {
    const f = fixture();
    expect(f.credentials.resolve).not.toHaveBeenCalled();
    await f.source.read();
    expect(f.request).toHaveBeenCalledWith("https://api.deepseek.com/user/balance",expect.objectContaining({method:"GET",redirect:"error",headers:{Authorization:"Bearer PRIVATE-key"}}));
    f.credentials.resolve.mockResolvedValue({value:"changed-key"}); f.source.invalidate(true);
    f.request.mockRejectedValue(new Error("PRIVATE response"));
    const result = await f.source.read();
    expect(result.balance).toEqual({status:"unavailable",balances:[],source:"deepseek"});
    expect(result.today.pricedRequests).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); f.source.close();
  });
  it("rejects gateway, credential override and model endpoint substitutions before resolving a key", async () => {
    for (const profile of [null,{baseURL:"http://api.deepseek.com"},{baseURL:"https://api.deepseek.com.evil.invalid"},
      {baseURL:"https://api.deepseek.com/?key=x"},{models:[{id:"deepseek-flash",baseURL:"https://gateway.invalid"}]},
      {headers:{Authorization:"PRIVATE"}},
    ]) expect(officialProfile(profile)).toBe(false);
    expect(officialProfile({})).toBe(true); expect(officialProfile({baseURL:"https://api.deepseek.com/v1"})).toBe(true);
    const f = fixture(); f.settings.get.mockImplementation(namespace => namespace === "llm-pi-ai" ? {providers:{deepseek:{baseURL:"https://gateway.invalid"}}} : undefined);
    expect((await f.source.read()).balance.status).toBe("unconfigured");
    expect(f.credentials.resolve).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); f.source.close();
  });
  it("marks unreadable or excessive history partial and always closes the read handle", async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error("PRIVATE path"));
    const result = await f.source.read(); expect(result.today.partial).toBe(true); expect(f.close).toHaveBeenCalledOnce();
    f.next(); vi.mocked(f.persistence.list).mockResolvedValue([{header:{id:"private"},revision:2,sizeBytes:20*1024*1024}]);
    expect((await f.source.read()).today.partial).toBe(true); expect(f.read).toHaveBeenCalledOnce(); f.source.close();
  });
  it("does not invent balance or allow unbounded response data", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(new Response(JSON.stringify({is_available:false,balance_infos:[{currency:"CNY",total_balance:"-0.25"}]}),{headers:{"Content-Type":"application/json"}}));
    expect((await f.source.read()).balance.balances[0]?.remaining).toBe(-.25);
    for (const body of [JSON.stringify({is_available:true,balance_infos:[{currency:"CNY",total_balance:"NaN"}]}),"x".repeat(20000)]) {
      f.request.mockResolvedValueOnce(new Response(body,{headers:{"Content-Type":"application/json"}})); f.source.invalidate(true);
      expect((await f.source.read()).balance.status).toBe("unavailable");
    }
    f.source.close(); await expect(f.source.read()).rejects.toThrow("unavailable");
  });
  it("honors timeout cancellation and recovers without caching an aborted query", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.request.mockImplementationOnce(async (_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve,reject) => {
        options?.signal?.addEventListener("abort",()=>reject(new Error("PRIVATE timeout")),{once:true});
      }));
      const timed = expect(f.source.read()).rejects.toThrow("billing unavailable");
      await vi.advanceTimersByTimeAsync(8000); await timed;
      expect((await f.source.read()).balance.status).toBe("ready");
    } finally {f.source.close(); vi.useRealTimers();}
  });
  it("does not reuse yesterday's fold and never prices unknown model property names", () => {
    const midnight = Date.parse("2026-10-08T16:00:00Z");
    expect(foldDailyUsage([header(),message(1,usage,midnight)],0,"2026-10-08").priced).toBe(0);
    expect(foldDailyUsage([header(),message(1,usage,midnight)],0,"2026-10-09").priced).toBe(1);
    expect(foldDailyUsage([{...message(),data:{...message().data,message:{source:{provider:"deepseek",model:"__proto__"}}}}],0,"2026-10-08").unpriced).toBe(1);
  });
});
