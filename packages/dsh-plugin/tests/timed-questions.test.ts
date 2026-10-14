import {afterEach,describe,expect,it,vi} from "vitest";
import type {PetAnswer,PetInteraction,PetSnapshot} from "@starcried/starlite-dsh-protocol";
import {DshStateAggregator} from "../src/aggregator.js";
import {QuestionBridge} from "../src/questions.js";
const questions=[{id:"q",question:"Choose",detail:"Supporting detail",options:[{label:"Yes"},{label:"No"}],multiSelect:true}];
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function fixture(remainingMs=500){
  const snapshots:PetSnapshot[]=[],aggregator=new DshStateAggregator();await aggregator.start(value=>snapshots.push(value));
  const session={id:"PRIVATE-session"},agent={id:"PRIVATE-agent",session};
  let roots:unknown[]=[agent],registered:unknown=agent;
  let active:Array<{callId:string;state:string;questions:unknown}>=[];
  let listener:((session:unknown,key:string)=>void)|undefined,claims=0;
  const attachWait=vi.fn<(_agent:unknown,_id:string,signal:AbortSignal)=>AsyncIterable<unknown>>((_agent,_id,signal)=>(async function*(){
    claims++;let release!:()=>void;const done=new Promise<void>(resolve=>{release=resolve;});
    const abort=()=>release();signal.addEventListener("abort",abort,{once:true});
    try{yield {remainingMs};await done;}finally{claims--;signal.removeEventListener("abort",abort);}
  })());
  const answer=vi.fn(async()=>true);
  const unsubscribe=vi.fn(()=>{listener=undefined;});
  const services:Record<string,unknown>={
    agents:{get:()=>registered,roots:()=>roots},
    userQuestions:{attachWait,answer},
    sessionProjections:{stateOf:()=>({questions:{active}}),onChanged:(value:typeof listener)=>{listener=value;return unsubscribe;}},
  };
  const open=vi.fn(async()=>undefined),bridge=new QuestionBridge(aggregator,open,{get:name=>services[name]});
  bridge.setConnected(true);bridge.setEnabled(true);await settle();
  return {bridge,aggregator,snapshots,session,agent,services,attachWait,answer,unsubscribe,open,
    claims:()=>claims,owner:(value:unknown)=>{registered=value;},roots:(value:unknown[])=>{roots=value;},
    project:(state="continued",callId="PRIVATE-call",batch:unknown=questions)=>{active=[{callId,state,questions:batch}];listener?.(session,"userQuestions");},
    remove:()=>{active=[];listener?.(session,"userQuestions");},
    wait:(next=vi.fn(async()=>"official-answer"))=>({next,result:bridge.ask(session,{agent,questions,wait:{callId:"PRIVATE-call",timed:true}},next)}),
    request:()=>bridge.read(snapshots.at(-1)!.inputRequest!)!,
    close:async()=>{bridge.close();await settle();await aggregator.stop();},
  };
}
function reply(request:PetInteraction):PetAnswer{return {requestId:request.requestId,sessionRef:request.sessionRef,answers:[{id:"q",selected:["Yes","No"],custom:"My answer"}]};}
afterEach(()=>vi.useRealTimers());

describe("official timed and continued user questions",()=>{
  it("claims the official wait, keeps details and answers once without exposing identities",async()=>{
    const f=await fixture();try{
      const wait=f.wait();await settle();const request=f.request();
      expect(f.claims()).toBe(1);expect(f.attachWait).toHaveBeenCalledExactlyOnceWith(f.agent,"PRIVATE-call",expect.any(AbortSignal));
      expect(f.snapshots.at(-1)).toMatchObject({state:"approval",activity:"waiting"});
      expect(request.questions[0]?.detail).toBe("Supporting detail");expect(JSON.stringify([request,f.snapshots])).not.toContain("PRIVATE");
      await f.bridge.answer(reply(request));expect(await wait.result).toEqual({answers:reply(request).answers});await settle();
      expect(f.claims()).toBe(0);expect(wait.next).not.toHaveBeenCalled();expect(f.answer).not.toHaveBeenCalled();
      await expect(f.bridge.answer(reply(request))).rejects.toThrow("no longer pending");
    }finally{await f.close();}
  });
  it("uses the Host duration, expires precisely, then accepts a new continued reference",async()=>{
    vi.useFakeTimers();const f=await fixture(750);try{
      const wait=f.wait();const expired=expect(wait.result).rejects.toMatchObject({name:"UserQuestionError",code:"ASK_TIMED_OUT"});
      await settle();const request=f.request();await vi.advanceTimersByTimeAsync(749);expect(f.bridge.read(request.requestId)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);await expired;expect(f.claims()).toBe(0);expect(wait.next).not.toHaveBeenCalled();
      f.project();await settle();const late=f.request();expect(late.requestId).not.toBe(request.requestId);
      await expect(f.bridge.answer(reply(request))).rejects.toThrow();await f.bridge.answer(reply(late));
      expect(f.answer).toHaveBeenCalledExactlyOnceWith(f.agent,"PRIVATE-call",{answers:reply(late).answers});
      expect(f.snapshots.at(-1)?.state).toBe("idle");
    }finally{await f.close();}
  });
  it("rejects an answer past the deadline even when the event loop has not run its timer",async()=>{
    vi.useFakeTimers();const f=await fixture(500);try{
      const wait=f.wait();const expired=expect(wait.result).rejects.toMatchObject({code:"ASK_TIMED_OUT"});await settle();const request=f.request();
      vi.setSystemTime(Date.now()+501);await expect(f.bridge.answer(reply(request))).rejects.toThrow("no longer pending");await expired;
      expect(f.answer).not.toHaveBeenCalled();expect(f.claims()).toBe(0);
    }finally{await f.close();}
  });
  it("starts the authoritative remaining duration after a delayed opening frame arrives",async()=>{
    vi.useFakeTimers();const f=await fixture();try{
      f.attachWait.mockImplementation((_agent,_id,signal)=>(async function*(){
        await new Promise<void>(resolve=>setTimeout(resolve,500));
        yield {remainingMs:750};
        await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
      })());
      const wait=f.wait();const expired=expect(wait.result).rejects.toMatchObject({code:"ASK_TIMED_OUT"});
      await settle();await vi.advanceTimersByTimeAsync(500);await settle();
      const request=f.request();expect(request).toBeDefined();
      await vi.advanceTimersByTimeAsync(749);expect(f.bridge.read(request.requestId)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);await expired;
      expect(f.bridge.read(request.requestId)).toBeUndefined();expect(wait.next).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it.each(["disconnect","privacy","close"])("releases a live claim and delegates on %s",async reason=>{
    const f=await fixture();try{
      const wait=f.wait();await settle();expect(f.claims()).toBe(1);
      if(reason==="disconnect")f.bridge.setConnected(false);else if(reason==="privacy")f.bridge.setEnabled(false);else f.bridge.close();
      expect(await wait.result).toBe("official-answer");await settle();expect(f.claims()).toBe(0);expect(wait.next).toHaveBeenCalledOnce();
      expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it("releases claims on owner cancellation without delegating cancelled questions",async()=>{
    const f=await fixture();try{
      const signal=new AbortController();const next=vi.fn(async()=>"wrong");
      const result=f.bridge.ask(f.session,{agent:f.agent,questions,signal:signal.signal,wait:{callId:"PRIVATE-call",timed:true}},next);
      const cancelled=expect(result).rejects.toMatchObject({code:"ASK_ABORTED"});await settle();signal.abort();await cancelled;await settle();
      expect(f.claims()).toBe(0);expect(next).not.toHaveBeenCalled();expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it.each([undefined,-1,Infinity,1.5,2_147_483_648])("delegates an invalid authoritative wait frame %s",async remaining=>{
    const f=await fixture();try{
      f.attachWait.mockImplementation(()=>(async function*(){yield {remainingMs:remaining};})());
      const wait=f.wait();expect(await wait.result).toBe("official-answer");expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it("fails open when a required public wait or live-root capability is absent",async()=>{
    const f=await fixture();try{
      for(const change of [()=>{f.services.userQuestions={answer:f.answer};},()=>{f.services.userQuestions={attachWait:f.attachWait,answer:f.answer};f.owner({});},()=>{f.owner(f.agent);f.roots([]);}]){
        change();const wait=f.wait();expect(await wait.result).toBe("official-answer");expect(wait.next).toHaveBeenCalledOnce();
      }
      expect(f.attachWait).not.toHaveBeenCalled();expect(f.answer).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it("keeps continued input available without changing actual working or idle animation",async()=>{
    vi.useFakeTimers();const f=await fixture();try{
      f.aggregator.handleAgentStatus(f.session,"running");f.aggregator.handleSessionEvent(f.session,{type:"tool/call",data:{callId:"tool",name:"bash"}});
      f.project();await settle();const request=f.request();expect(f.snapshots.at(-1)).toMatchObject({state:"working",activity:"command",inputRequest:request.requestId});
      f.bridge.cancelForeground(f.session);expect(f.bridge.read(request.requestId)).toBeDefined();
      f.aggregator.handleSessionEvent(f.session,{type:"turn/end",data:{reason:{kind:"cancelled"}}});
      expect(f.snapshots.at(-1)).toMatchObject({state:"idle",activity:"idle",inputRequest:request.requestId});
      const wait=f.wait();await settle();const foreground=f.request();expect(foreground.requestId).not.toBe(request.requestId);expect(f.snapshots.at(-1)?.state).toBe("approval");
      f.project("continued","PRIVATE-older");await settle();expect(f.snapshots.at(-1)?.inputRequest).toBe(foreground.requestId);
      await f.bridge.answer(reply(foreground));await wait.result;
    }finally{await f.close();}
  });
  it("does not cover an actual tool permission with a continued answer form",async()=>{
    const f=await fixture();try{
      f.project();await settle();f.aggregator.handleApprovalRequested(f.session,"permission","bash");
      expect(f.snapshots.at(-1)).toMatchObject({state:"approval",activity:"waiting"});expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it("checks the authoritative projection and exact live root before a continued answer",async()=>{
    const f=await fixture();try{
      f.project();await settle();let request=f.request();f.remove();
      await expect(f.bridge.answer(reply(request))).rejects.toThrow();expect(f.answer).not.toHaveBeenCalled();await settle();
      f.project();await settle();request=f.request();f.owner({});
      await expect(f.bridge.answer(reply(request))).rejects.toThrow();expect(f.answer).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it("atomically retires a late reference before the official reply settles, and honors owner rejection",async()=>{
    const f=await fixture();try{
      f.project();await settle();const request=f.request();let finish!:(value:boolean)=>void;
      f.answer.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
      const posting=f.bridge.answer(reply(request));await expect(f.bridge.answer(reply(request))).rejects.toThrow();expect(f.answer).toHaveBeenCalledOnce();
      finish(false);await expect(posting).rejects.toThrow();f.bridge.refresh();await settle();expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it("rotates changed question references and retires a reply accepted in another UI",async()=>{
    const f=await fixture();try{
      f.project();await settle();const old=f.request();f.project("continued","PRIVATE-call",[{...questions[0],question:"Updated"}]);await settle();
      expect(f.request().requestId).not.toBe(old.requestId);await expect(f.bridge.answer(reply(old))).rejects.toThrow();
      const current=f.request();await f.bridge.answer(reply(current));f.bridge.refresh();await settle();expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();
    }finally{await f.close();}
  });
  it("does not reclaim a delegated continued question during automatic availability refresh",async()=>{
    const f=await fixture();try{
      f.project();await settle();const request=f.request();f.bridge.setEnabled(false);f.bridge.setEnabled(true);await settle();
      await f.bridge.open(request.sessionRef);f.bridge.setEnabled(true);f.bridge.refresh();await settle();
      expect(f.snapshots.at(-1)?.inputRequest).toBeUndefined();expect(f.open).toHaveBeenCalledExactlyOnceWith(f.session);
      expect(f.answer).not.toHaveBeenCalled();f.remove();await settle();f.project("continued","PRIVATE-new");await settle();expect(f.request()).toBeDefined();
    }finally{await f.close();}
  });
});
