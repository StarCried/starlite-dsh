import { describe, expect, it, vi } from "vitest";
import { StatusConnection } from "../src/connection.js";
const URL = "dsh-inochi2d-pet://connect?port=45678&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&instance=123e4567-e89b-42d3-a456-426614174000";
const valid = {billingVersion:1,checkedAt:1,balance:{status:"ready",balances:[{currency:"CNY",remaining:12}]},
  today:{date:"2026-10-08",timeZone:"Asia/Shanghai",partial:false,pricedRequests:0,unpricedRequests:0,pricingDate:"2026-10-08",estimates:[]}};
const callbacks={onSnapshot:()=>{},onConnected:()=>{},onDisconnected:()=>{}};
const events=()=>new Response(new ReadableStream<Uint8Array>(),{headers:{"Content-Type":"text/event-stream"}});
describe("billing connection",()=>{
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
