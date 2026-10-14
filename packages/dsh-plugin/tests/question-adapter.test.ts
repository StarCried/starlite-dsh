import {expect,it,vi} from "vitest";
import type {PetSnapshot} from "@starcried/starlite-dsh-protocol";
import {startDshAdapter} from "../src/adapter.js";
import type {QuestionBridge} from "../src/questions.js";

it("wires official continued questions through the adapter without blocking turns or taking tool approvals",async()=>{
  const snapshots:PetSnapshot[]=[],listeners=new Map<string,(...args:unknown[])=>unknown>();
  const session={id:"PRIVATE-session"},agent={id:"PRIVATE-agent",session};
  let projectionListener:((session:unknown,key:string)=>void)|undefined;
  let active:unknown[]=[{callId:"PRIVATE-call",state:"continued",questions:[{id:"q",question:"Choose",options:[{label:"Yes"}]}]}];
  const answer=vi.fn(async()=>true),unsubscribe=vi.fn();
  const services:Record<string,unknown>={
    agents:{get:()=>agent,roots:()=>[agent]},
    userQuestions:{attachWait:async function*(){},answer},
    sessionProjections:{stateOf:()=>({questions:{active}}),onChanged:(listener:typeof projectionListener)=>{projectionListener=listener;return unsubscribe;}},
  };
  let bridge:QuestionBridge|undefined;
  const stop=await startDshAdapter({get:name=>services[name],on:(event,listener)=>{listeners.set(event,listener);return ()=>listeners.delete(event);}}, {
    host:()=>"windows",
    startServer:async(source,options)=>{bridge=options?.questions;await source.start(value=>snapshots.push(value));return {port:41234,token:"a".repeat(43),close:()=>source.stop()};},
    launch:async()=>undefined,
  });
  try{
    bridge!.setConnected(true);bridge!.setEnabled(true);
    listeners.get("agent/status")?.({agent,status:"running"});
    await vi.waitFor(()=>expect(snapshots.at(-1)?.inputRequest).toBeDefined());
    const id=snapshots.at(-1)!.inputRequest!,request=bridge!.read(id)!;expect(snapshots.at(-1)?.state).toBe("thinking");
    listeners.get("session/event")?.(session,{type:"turn/end",data:{reason:{kind:"cancelled"}}});
    expect(snapshots.at(-1)).toMatchObject({state:"idle",inputRequest:id});
    let resolveApproval!:(answer:string)=>void;
    const next=vi.fn(()=>new Promise<string>(resolve=>{resolveApproval=resolve;}));
    const permission=listeners.get("approval/request")?.({agent,toolName:"bash"},next) as Promise<unknown>;
    expect(snapshots.at(-1)?.state).toBe("approval");expect(snapshots.at(-1)?.inputRequest).toBeUndefined();expect(answer).not.toHaveBeenCalled();
    resolveApproval("official-approved");await expect(permission).resolves.toBe("official-approved");expect(next).toHaveBeenCalledOnce();
    await bridge!.answer({requestId:id,sessionRef:request.sessionRef,answers:[{id:"q",selected:["Yes"]}]});
    expect(answer).toHaveBeenCalledExactlyOnceWith(agent,"PRIVATE-call",{answers:[{id:"q",selected:["Yes"]}]});
    active=[];projectionListener?.(session,"userQuestions");
    expect(JSON.stringify(snapshots)).not.toContain("PRIVATE");
  }finally{await stop();}
  expect(unsubscribe).toHaveBeenCalledOnce();
});
