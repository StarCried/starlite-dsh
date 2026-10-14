import {randomUUID} from "node:crypto";
import {parsePetInteraction,parsePetAnswer,type PetInteraction,type PetAnswer} from "@starcried/starlite-dsh-protocol";
import type {DshStateAggregator} from "./aggregator.js";

interface Services {get?(name:string):unknown}
interface QuestionService {
  attachWait(agent:unknown,callId:string,signal:AbortSignal):AsyncIterable<unknown>;
  answer(agent:unknown,callId:string,answer:{answers:PetAnswer["answers"]}):boolean|Promise<boolean>;
}
interface ProjectionService {
  stateOf(session:unknown,key:"userQuestions"):unknown;
  onChanged(listener:(session:unknown,key:string)=>void):()=>void;
}
interface AgentDirectory {get(id:string):unknown;roots():readonly unknown[]}
interface LateQuestion {agent:unknown;key:unknown;callId:string;request:PetInteraction}
interface Pending {
  key:unknown;request:PetInteraction;late?:LateQuestion;deadline?:number;
  finish:(answer:PetAnswer|undefined)=>void;abort:(code?:string)=>void;
}
const MAX_PENDING=32;
const MAX_TIMER=2_147_483_647;

/** Ordinary questions only. Tool permission approvals remain owned by DSH. */
export class QuestionBridge {
  readonly #pending=new Map<string,Pending>();
  readonly #suppressed=new Map<unknown,Set<string>>();
  #connected=false;#enabled=false;#closed=false;#refreshQueued=false;
  #unsubscribe:(()=>void)|undefined;
  constructor(readonly aggregator:DshStateAggregator,readonly openSession:(key:unknown)=>Promise<void>,readonly services:Services={}){}
  setConnected(value:boolean):void{this.#connected=value;if(!value)this.#delegateAll();else this.refresh();}
  setEnabled(value:boolean):void{this.#enabled=value;if(!value)this.#delegateAll();else this.refresh();}
  close():void{this.#closed=true;this.#delegateAll();this.#unsubscribe?.();this.#unsubscribe=undefined;this.#suppressed.clear();}
  read(id:string):PetInteraction|undefined{
    const pending=this.#pending.get(id);
    if(pending?.deadline!==undefined&&Date.now()>=pending.deadline)pending.abort("ASK_TIMED_OUT");
    if(pending?.late&&!this.#currentLate(pending.late))pending.finish(undefined);
    return this.#pending.get(id)?.request;
  }
  async answer(raw:unknown):Promise<void>{
    const requestId=record(raw)?.requestId;
    const pending=typeof requestId==="string"?this.#pending.get(requestId):undefined;
    if(!pending)throw Error("question no longer pending");
    const answer=parsePetAnswer(raw,pending.request);
    if(pending.deadline!==undefined&&Date.now()>=pending.deadline){pending.abort("ASK_TIMED_OUT");throw Error("question no longer pending");}
    if(!pending.late){pending.finish(answer);return;}
    const late=pending.late,service=this.#questionService();
    if(!service||!this.#currentLate(late)){pending.finish(undefined);throw Error("question no longer pending");}
    // Retire the random reference before calling the owner. Its atomic method
    // validates the live root and refuses stale or already queued replies.
    this.#suppress(late.key,late.callId);pending.finish(undefined);
    if(await service.answer(late.agent,late.callId,{answers:answer.answers})!==true)throw Error("question no longer pending");
  }
  async open(ref:string):Promise<void>{
    const key=this.aggregator.sessionKey(ref);if(key===undefined||this.#closed)throw Error("session unavailable");
    const captured=[...this.#pending.values()].filter(item=>item.key===key);
    await this.openSession(key);
    if(this.#closed||this.aggregator.sessionKey(ref)!==key)return;
    // Navigation may fail or outlive its question. Only a successful open can
    // delegate the same captured request; a newer form keeps its own lifetime.
    for(const pending of captured){
      if(this.#pending.get(pending.request.requestId)!==pending)continue;
      if(pending.deadline!==undefined&&Date.now()>=pending.deadline)continue;
      if(pending.late){
        if(!this.#currentLate(pending.late))continue;
        this.#suppress(key,pending.late.callId);
      }
      pending.finish(undefined);
    }
  }
  async openWebUi():Promise<void>{if(this.#closed)throw Error("DSH Web UI unavailable");await this.openSession(undefined);}
  cancelForeground(key:unknown):void{for(const item of this.#pending.values())if(item.key===key&&!item.late)item.abort();}
  cancelSession(key:unknown):void{
    for(const item of this.#pending.values())if(item.key===key)item.abort();
    this.#suppressed.delete(key);
  }
  /** Called after agent changes; projection changes have their own public feed. */
  refresh():void{
    if(this.#closed||!this.#connected||!this.#enabled)return;
    if(!this.#unsubscribe){
      const projections=this.#projectionService();
      if(projections)try{this.#unsubscribe=projections.onChanged((_session,key)=>{if(key==="userQuestions")this.refresh();});}catch{return;}
    }
    if(this.#refreshQueued)return;
    this.#refreshQueued=true;
    queueMicrotask(()=>{this.#refreshQueued=false;if(!this.#closed&&this.#connected&&this.#enabled)this.#reconcile();});
  }
  async ask(key:unknown,raw:unknown,next:()=>Promise<unknown>):Promise<unknown>{
    if(this.#closed||!this.#connected||!this.#enabled)return next();
    const source=record(raw);let request:PetInteraction;
    try{request=this.#request(key,source?.questions);}catch{return next();}
    const signal=source?.signal;
    if(signal!==undefined&&!(signal instanceof AbortSignal))return next();
    if(signal?.aborted)throw questionError("ASK_ABORTED");
    const wait=record(source?.wait),timed=wait?.timed===true;
    const callId=validCallId(wait?.callId)?wait.callId:undefined;
    const service=this.#questionService();
    if(source?.wait!==undefined&&(!wait||!callId||(wait.timed!==undefined&&typeof wait.timed!=="boolean")))return next();
    if(timed&&(!callId||!service||!this.#liveRoot(source?.agent,key)))return next();
    this.#suppressed.delete(key);
    if(this.#pending.size>=MAX_PENDING){
      const late=[...this.#pending.values()].find(item=>item.late);late?.finish(undefined);
      if(this.#pending.size>=MAX_PENDING)return next();
    }
    let iterator:AsyncIterator<unknown>|undefined;
    const claim=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let published=false,settled=false;
    const answer=await new Promise<PetAnswer|undefined>((resolve,reject)=>{
      const sourceAborted=()=>abort(record(signal?.reason)?.code==="ASK_TIMED_OUT"?"ASK_TIMED_OUT":"ASK_ABORTED");
      const cleanup=()=>{
        this.#pending.delete(request.requestId);signal?.removeEventListener("abort",sourceAborted);
        clearTimeout(timer);claim.abort();
        if(iterator?.return)void iterator.return().catch(()=>undefined);
        if(published)this.aggregator.handleInputResolved(key,request.requestId);
      };
      const finish=(value:PetAnswer|undefined)=>{if(settled)return;settled=true;cleanup();resolve(value);};
      const abort=(code="ASK_ABORTED")=>{if(settled)return;settled=true;cleanup();reject(questionError(code));};
      const pending:Pending={key,request,finish,abort};
      this.#pending.set(request.requestId,pending);
      signal?.addEventListener("abort",sourceAborted,{once:true});
      const publish=()=>{published=true;this.aggregator.handleInputRequested(key,request.requestId);};
      if(!timed){publish();return;}
      void (async()=>{
        try{
          iterator=service!.attachWait(source!.agent,callId!,claim.signal)[Symbol.asyncIterator]();
          const first=await iterator.next();
          if(settled)return;
          const remaining=record(first.value)?.remainingMs;
          if(first.done||!Number.isSafeInteger(remaining)||Number(remaining)<0||Number(remaining)>MAX_TIMER){finish(undefined);return;}
          // Match the official Client: the Host duration starts at receipt of
          // the opening frame, without subtracting time spent obtaining it.
          pending.deadline=Date.now()+Number(remaining);
          request.wait={state:"timed",deadline:pending.deadline};
          if(Date.now()>=pending.deadline){abort("ASK_TIMED_OUT");return;}
          timer=setTimeout(()=>abort("ASK_TIMED_OUT"),pending.deadline-Date.now());timer.unref();publish();
          // The public stream holds the claim until cancellation or settlement.
          await iterator.next();if(!settled)finish(undefined);
        }catch{if(!settled)finish(undefined);}
      })();
    });
    return answer?{answers:answer.answers}:next();
  }
  #request(key:unknown,questions:unknown):PetInteraction{return parsePetInteraction({interactionVersion:1,requestId:randomUUID(),sessionRef:this.aggregator.sessionInfo(key).ref,questions});}
  #questionService():QuestionService|undefined{
    const service=this.#service("userQuestions");
    return typeof service?.attachWait==="function"&&typeof service.answer==="function"?service as unknown as QuestionService:undefined;
  }
  #projectionService():ProjectionService|undefined{
    const service=this.#service("sessionProjections");
    return typeof service?.stateOf==="function"&&typeof service.onChanged==="function"?service as unknown as ProjectionService:undefined;
  }
  #directory():AgentDirectory|undefined{
    const service=this.#service("agents");
    return typeof service?.get==="function"&&typeof service.roots==="function"?service as unknown as AgentDirectory:undefined;
  }
  #service(name:string):Record<string,unknown>|undefined{try{return record(this.services.get?.(name));}catch{return undefined;}}
  #liveRoot(agent:unknown,key:unknown):boolean{
    try{const row=record(agent),directory=this.#directory();return Boolean(row&&directory&&row.session===key&&typeof row.id==="string"&&directory.get(row.id)===agent&&directory.roots().includes(agent));}catch{return false;}
  }
  #lateQuestions():LateQuestion[]{
    const service=this.#questionService(),projections=this.#projectionService(),directory=this.#directory();
    if(!service||!projections||!directory)return [];
    const result:LateQuestion[]=[];
    try{
      for(const agent of directory.roots().slice(0,128)){
        const key=record(agent)?.session;if(!key||!this.#liveRoot(agent,key))continue;
        const active=record(record(projections.stateOf(key,"userQuestions"))?.questions)?.active;
        if(!Array.isArray(active)||active.length>MAX_PENDING)continue;
        for(const raw of active){
          const item=record(raw);if(item?.state!=="continued"||!validCallId(item.callId))continue;
          try{const request=this.#request(key,item.questions);request.wait={state:"continued"};result.push({agent,key,callId:item.callId,request});}catch{continue;}
          if(result.length>=MAX_PENDING)return result;
        }
      }
    }catch{return [];}
    return result;
  }
  #currentLate(late:LateQuestion):boolean{
    return !this.#closed&&this.#connected&&this.#enabled&&!this.#suppressed.get(late.key)?.has(late.callId)
      &&this.#lateQuestions().some(item=>sameLate(item,late));
  }
  #reconcile():void{
    const current=this.#lateQuestions();
    for(const pending of this.#pending.values())if(pending.late&&!current.some(item=>sameLate(item,pending.late!)))pending.finish(undefined);
    for(const [key,ids] of this.#suppressed){for(const id of ids)if(!current.some(item=>item.key===key&&item.callId===id))ids.delete(id);if(!ids.size)this.#suppressed.delete(key);}
    for(const late of current){
      if(this.#pending.size>=MAX_PENDING)break;
      if(this.#suppressed.get(late.key)?.has(late.callId)||[...this.#pending.values()].some(item=>item.late&&sameLate(item.late,late)))continue;
      const request=late.request;
      const finish=()=>{this.#pending.delete(request.requestId);this.aggregator.handleInputResolved(late.key,request.requestId);};
      this.#pending.set(request.requestId,{key:late.key,request,late,finish,abort:finish});
      this.aggregator.handleInputRequested(late.key,request.requestId,false);
    }
  }
  #suppress(key:unknown,callId:string):void{const ids=this.#suppressed.get(key)??new Set<string>();ids.add(callId);this.#suppressed.set(key,ids);}
  #delegateAll():void{for(const item of this.#pending.values())item.finish(undefined);}
}
function sameLate(a:LateQuestion,b:LateQuestion):boolean{return a.agent===b.agent&&a.key===b.key&&a.callId===b.callId&&JSON.stringify(a.request.questions)===JSON.stringify(b.request.questions);}
function validCallId(value:unknown):value is string{return typeof value==="string"&&value.length>0&&value.length<=256&&!/[\p{Cc}]/u.test(value);}
function questionError(code:string):Error&{code:string}{return Object.assign(new Error("question no longer pending"),{name:"UserQuestionError",code});}
function record(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
