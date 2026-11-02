import { describe, expect, it, vi } from "vitest";
import { StatusConnection } from "../src/connection.js";
import { BILLING_REQUEST_TIMEOUT_MS } from "@starcried/starlite-dsh-protocol";
const URL = "dsh-inochi2d-pet://connect?port=45678&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&instance=123e4567-e89b-42d3-a456-426614174000";
const valid = {billingVersion:1,checkedAt:1,balance:{status:"ready",balances:[{currency:"CNY",remaining:12}]},
  today:{date:"2026-10-08",timeZone:"Asia/Shanghai",partial:false,pricedRequests:0,unpricedRequests:0,pricingDate:"2026-10-08",estimates:[]}};
const callbacks={onSnapshot:()=>{},onConnected:()=>{},onDisconnected:()=>{}};
const events=()=>new Response(new ReadableStream<Uint8Array>(),{headers:{"Content-Type":"text/event-stream"}});
describe("billing connection",()=>{
  it("waits for the official account service without extending navigation timeouts",async()=>{
    vi.useFakeTimers();
    const account={...valid,balance:{status:"ready",source:"deepseek-account",balances:[{currency:"CNY",remaining:12}],bonusBalances:[{currency:"CNY",remaining:.2}]},
      today:{...valid.today,scope:"account",partial:true}};
    const request:typeof fetch=async(input,options)=>{
      if(String(input).endsWith("/events"))return events();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>resolve(new Response(JSON.stringify(account),{headers:{"Content-Type":"application/json"}})),30_000);
        options?.signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("cancelled"));},{once:true});
      });
    };
    const connection=new StatusConnection(callbacks,request);connection.connect(URL);await Promise.resolve();
    try {
      const billing=connection.readBilling();let done=false;void billing.then(()=>{done=true;});
      const navigation=expect(connection.openWebUi()).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(10_000);await navigation;expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);expect(await billing).toEqual(account);
    }finally{connection.stop();vi.useRealTimers();}
  });
  it("bounds a stalled balance request and cancels it immediately on disconnect",async()=>{
    vi.useFakeTimers();
    const request:typeof fetch=async(input,options)=>{
      if(String(input).endsWith("/events"))return events();
      return new Promise((_resolve,reject)=>options?.signal?.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));
    };
    const connection=new StatusConnection(callbacks,request);connection.connect(URL);await Promise.resolve();
    try {
      const pending=connection.readBilling();let rejected=false;void pending.catch(()=>{rejected=true;});
      const timed=expect(pending).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS-1);expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);await timed;
      const second=expect(connection.readBilling()).rejects.toThrow("cancelled");connection.stop();await second;
    }finally{connection.stop();vi.useRealTimers();}
  });
  it("uses only the authenticated loopback descriptor and canonical financial fields",async()=>{
    let receiver:unknown="unset"; const calls:{url:string;options:RequestInit|undefined}[]=[];
    const request=async function(this:unknown,input:RequestInfo|URL,options?:RequestInit){
      receiver=this; calls.push({url:String(input),options});
      if(String(input).endsWith("/events"))return events();
      return new Response(JSON.stringify({...valid,key:"PRIVATE"}),{headers:{"Content-Type":"application/json"}});
    };
    const connection=new StatusConnection(callbacks,request); connection.connect(URL);
    await Promise.resolve();
    try {
      const result=await connection.readBilling(); expect(result).toEqual(valid); expect(receiver).toBeUndefined();
      expect(calls.at(-1)?.url).toBe("http://127.0.0.1:45678/v1/billing");
      expect(calls.at(-1)?.options?.headers).toEqual({Authorization:"Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
    }finally{connection.stop();}
  });
  it("rejects excessive or malformed money and aborts pending reads when the source is replaced",async()=>{
    const request=vi.fn<typeof fetch>(async input=>{
      if(String(input).endsWith("/events"))return events();
      return new Response("x".repeat(5000),{headers:{"Content-Type":"application/json"}});
    });
    const connection=new StatusConnection(callbacks,request); connection.connect(URL);
    await Promise.resolve();
    try {
      await expect(connection.readBilling()).rejects.toThrow("too large");
      request.mockImplementation(async (input,options)=>{
        if(String(input).endsWith("/events"))return events();
        return new Promise((_done,reject)=>options?.signal?.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));
      });
      const pending=expect(connection.readBilling()).rejects.toThrow("cancelled"); connection.stop(); await pending;
      await expect(connection.readBilling()).rejects.toThrow("disconnected");
    }finally{connection.stop();}
  });
});
