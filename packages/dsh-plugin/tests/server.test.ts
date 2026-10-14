import { describe, expect, it, vi } from "vitest";
import { PET_PROTOCOL_VERSION, type PetStateSource } from "@starcried/starlite-dsh-protocol";
import { isBrowserSafePort, startStatusServer } from "../src/server.js";
import {DshStateAggregator} from "../src/aggregator.js";
import {QuestionBridge} from "../src/questions.js";

function idleSource(): PetStateSource {
  return {
    async start(emit) {
      emit({
        protocolVersion: PET_PROTOCOL_VERSION,
        sequence: 0,
        emittedAt: Date.now(),
        state: "idle",
        ...({ userMessage: "TOP SECRET" } as object),
      });
    },
    async stop() {},
  };
}

describe("status SSE server", () => {
  it("rejects malformed or oversized question responses without terminating the Host",async()=>{
    const source=new DshStateAggregator(),bridge=new QuestionBridge(source,async()=>undefined),server=await startStatusServer(source,{questions:bridge});
    const read=vi.spyOn(bridge,"read"),id="123e4567-e89b-42d3-a456-426614174001",headers={Authorization:`Bearer ${server.token}`};
    const request={interactionVersion:1 as const,requestId:id,sessionRef:"123e4567-e89b-42d3-a456-426614174000",questions:Array.from({length:4},(_,i)=>({id:String(i),question:"Choose",options:[],multiSelect:false,detail:"x".repeat(8192)}))};
    const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
    request.questions[3]!.detail=request.questions[3]!.detail.slice(0,8192-(bytes(request)-32750));expect(bytes(request)).toBe(32750);
    try{
      for(const value of [{...request,wait:{state:"timed",deadline:1_800_000_012_000,issuedAt:1_800_000_000_000}},{...request,questions:[{id:"q",question:"Choose",options:[],multiSelect:false}],wait:{state:"timed",deadline:NaN,issuedAt:0}}]){
        read.mockReturnValueOnce(value as ReturnType<QuestionBridge["read"]>);
        const response=await fetch(`http://127.0.0.1:${server.port}/v1/interaction?request=${id}`,{headers});expect(response.status).toBe(409);expect(await response.text()).toBe("");
      }
      read.mockImplementationOnce(()=>{throw Error("PRIVATE request failure");});
      expect((await fetch(`http://127.0.0.1:${server.port}/v1/interaction?request=${id}`,{headers})).status).toBe(409);
      expect((await fetch(`http://127.0.0.1:${server.port}/v1/health`,{headers})).status).toBe(204);
    }finally{await server.close();}
  });
  it("waits for the official continued-answer result before acknowledging HTTP success",async()=>{
    const source=new DshStateAggregator(),bridge=new QuestionBridge(source,async()=>undefined);
    let entered!:()=>void,complete!:()=>void,reject!:(error:Error)=>void;
    const called=new Promise<void>(resolve=>{entered=resolve;});
    const officialResult=new Promise<void>((resolve,fail)=>{complete=resolve;reject=fail;});
    const answer=vi.spyOn(bridge,"answer").mockImplementation(()=>{entered();return officialResult;});
    const server=await startStatusServer(source,{questions:bridge});
    const controller=new AbortController();
    let response:Promise<Response>|undefined;
    try{
      let settled=false;
      response=fetch(`http://127.0.0.1:${server.port}/v1/interaction/answer`,{method:"POST",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(3000)]),
        headers:{Authorization:`Bearer ${server.token}`,"Content-Type":"application/json"},body:"{}"}).then(value=>{settled=true;return value;});
      // Synchronize with the actual HTTP handler; transport failure or an early
      // HTTP response must fail instead of leaving an unobserved pending fetch.
      await Promise.race([called,response.then(()=>{throw Error("HTTP completed before the official answer handler");})]);
      expect(answer).toHaveBeenCalledOnce();expect(settled).toBe(false);
      reject(Error("PRIVATE owner rejection"));const failed=await response;expect(failed.status).toBe(409);expect(await failed.text()).toBe("");
    }finally{controller.abort();complete();await response?.catch(()=>undefined);await server.close();}
  });
  it("requires a distinct authenticated empty action to open the Web UI home",async()=>{
    const source=new DshStateAggregator(),open=vi.fn(async()=>undefined),bridge=new QuestionBridge(source,open);
    const server=await startStatusServer(source,{questions:bridge});const base=`http://127.0.0.1:${server.port}`;
    const headers={Authorization:`Bearer ${server.token}`,"Content-Type":"application/json",Origin:"http://tauri.localhost"};
    const post=(path:string,body:unknown,requestHeaders:HeadersInit=headers)=>fetch(`${base}${path}`,{method:"POST",headers:requestHeaders,body:JSON.stringify(body)});
    try{
      expect((await post("/v1/web/open",{}, {"Content-Type":"application/json"})).status).toBe(401);
      expect((await post("/v1/web/open",{}, {...headers,Origin:"https://evil.invalid"})).status).toBe(403);
      for(const body of [null,[],{sessionRef:null},{url:"http://evil.invalid/"}])expect((await post("/v1/web/open",body)).status).toBe(409);
      expect((await post("/v1/session/open",{})).status).toBe(409);
      const key={id:"PRIVATE session"},ref=source.sessionInfo(key).ref;source.disposeSession(key);
      expect((await post("/v1/session/open",{sessionRef:ref})).status).toBe(409);expect(open).not.toHaveBeenCalled();
      const response=await post("/v1/web/open",{});expect(response.status).toBe(204);expect(await response.text()).toBe("");
      expect(open).toHaveBeenCalledExactlyOnceWith(undefined);
      open.mockRejectedValueOnce(Error("PRIVATE authenticated URL"));
      const failed=await post("/v1/web/open",{});expect(failed.status).toBe(409);expect(await failed.text()).toBe("");
    }finally{await server.close()}
  });
  it("answers one authenticated pending question and rejects stale/malformed actions",async()=>{
    const source=new DshStateAggregator(),open=vi.fn(async()=>undefined),bridge=new QuestionBridge(source,open);
    const server=await startStatusServer(source,{questions:bridge});const base=`http://127.0.0.1:${server.port}`;
    const headers={Authorization:`Bearer ${server.token}`,"Content-Type":"application/json",Origin:"http://tauri.localhost"};
    const stream=await fetch(`${base}/v1/events`,{headers});const reader=stream.body!.getReader();await reader.read();
    try{
      expect((await fetch(`${base}/v1/interaction/availability`,{method:"POST",headers,body:'{"enabled":true}'})).status).toBe(204);
      const key={id:"PRIVATE session"},ref=source.sessionInfo(key,"标题").ref;
      const next=vi.fn(async()=>undefined);const answer=bridge.ask(key,{questions:[{id:"q",question:"选择",options:[{label:"是"}]}]},next);
      const frame=await reader.read();const text=new TextDecoder().decode(frame.value);const requestId=/"inputRequest":"([^"]+)"/u.exec(text)?.[1];
      // An earlier title-only frame may share this read; consume until the input frame arrives.
      let id=requestId;for(let count=0;!id&&count<5;count++){const chunk=await reader.read();id=/"inputRequest":"([^"]+)"/u.exec(new TextDecoder().decode(chunk.value))?.[1]}
      expect(id).toBeDefined();
      const dto=await (await fetch(`${base}/v1/interaction?request=${id}`,{headers})).json();expect(JSON.stringify(dto)).not.toContain("PRIVATE");
      const body=JSON.stringify({requestId:id,sessionRef:ref,answers:[{id:"q",selected:["是"]}]});
      expect((await fetch(`${base}/v1/interaction/answer`,{method:"POST",headers:{...headers,Origin:"https://evil.invalid"},body})).status).toBe(403);
      expect((await fetch(`${base}/v1/interaction/answer`,{method:"POST",headers,body})).status).toBe(204);
      await expect(answer).resolves.toEqual({answers:[{id:"q",selected:["是"]}]});expect(next).not.toHaveBeenCalled();
      expect((await fetch(`${base}/v1/interaction/answer`,{method:"POST",headers,body})).status).toBe(409);
      expect((await fetch(`${base}/v1/session/open`,{method:"POST",headers,body:JSON.stringify({sessionRef:ref,url:"evil"})})).status).toBe(409);expect(open).not.toHaveBeenCalled();
      expect((await fetch(`${base}/v1/session/open`,{method:"POST",headers,body:JSON.stringify({sessionRef:ref})})).status).toBe(204);expect(open).toHaveBeenCalledExactlyOnceWith(key);
      expect((await fetch(`${base}/v1/interaction/availability`,{method:"POST",headers:{...headers,"Content-Type":"text/plain"},body:'{"enabled":false}'})).status).toBe(409);
    }finally{await reader.cancel();await server.close()}
  });
  it("authenticates and canonicalizes billing without leaking source extras", async () => {
    const billing = {read:vi.fn(async () => ({billingVersion:1 as const, checkedAt:1000,
      balance:{status:"ready" as const,balances:[{currency:"CNY" as const,remaining:12.34}], key:"PRIVATE key"},
      today:{date:"2026-10-08",timeZone:"Asia/Shanghai" as const,partial:false,pricedRequests:1,unpricedRequests:0,
        pricingDate:"2026-10-08",estimates:[{currency:"CNY" as const,minimum:.01,maximum:.02}]},session:"PRIVATE session"})),close:vi.fn()};
    const server = await startStatusServer(idleSource(),{billing});
    const endpoint = `http://127.0.0.1:${server.port}/v1/billing`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint,{headers:{Authorization:`Bearer ${server.token}`,Origin:"https://evil.invalid"}})).status).toBe(403);
      expect(billing.read).not.toHaveBeenCalled();
      const response = await fetch(endpoint,{headers:{Authorization:`Bearer ${server.token}`,Origin:"http://tauri.localhost"}});
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.text(); expect(result).toContain('"remaining":12.34'); expect(result).not.toContain("PRIVATE");
      billing.read.mockRejectedValueOnce(new Error("PRIVATE exception"));
      const failed = await fetch(endpoint,{headers:{Authorization:`Bearer ${server.token}`}});
      expect(failed.status).toBe(503); expect(await failed.text()).toBe("");
    } finally {await server.close();}
    expect(billing.close).toHaveBeenCalledOnce();
  });
  it("rejects ports blocked by browser fetch implementations", () => {
    expect(isBrowserSafePort(0)).toBe(false);
    expect(isBrowserSafePort(6000)).toBe(false);
    expect(isBrowserSafePort(6667)).toBe(false);
    expect(isBrowserSafePort(10_080)).toBe(false);
    expect(isBrowserSafePort(8084)).toBe(true);
    expect(isBrowserSafePort(65_535)).toBe(true);
  });

  it("binds loopback, requires bearer auth, and sends the initial snapshot", async () => {
    const server = await startStatusServer(idleSource());
    expect(isBrowserSafePort(server.port)).toBe(true);
    const endpoint = `http://127.0.0.1:${server.port}/v1/events`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);

      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("event: snapshot");
      expect(text).toContain('"state":"idle"');
      expect(text).not.toContain("TOP SECRET");
      expect(text).not.toContain("userMessage");
      await reader!.cancel();
    } finally {
      await server.close();
    }
  });

  it("allows only the Tauri origin for credentialed CORS", async () => {
    const server = await startStatusServer(idleSource());
    const endpoint = `http://127.0.0.1:${server.port}/v1/events`;
    try {
      const denied = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "https://attacker.invalid" },
      });
      expect(denied.status).toBe(403);

      const allowed = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "http://tauri.localhost" },
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");

      const development = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "http://127.0.0.1:1420" },
      });
      expect(development.status).toBe(204);
    } finally {
      await server.close();
    }
  });
});
