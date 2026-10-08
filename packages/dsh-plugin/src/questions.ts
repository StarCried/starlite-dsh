import {randomUUID} from "node:crypto";
import {parsePetInteraction,parsePetAnswer,type PetInteraction,type PetAnswer} from "@dsh-inochi2d-pet/protocol";
import type {DshStateAggregator} from "./aggregator.js";

interface Pending {
  key:unknown; request:PetInteraction; finish:(answer:PetAnswer|undefined)=>void; abort:()=>void;
}
/** Owns only pending ordinary questions; permission approvals stay in DSH. */
export class QuestionBridge {
  readonly #pending=new Map<string,Pending>();
  #connected=false; #enabled=false; #closed=false;
  constructor(readonly aggregator:DshStateAggregator,readonly openSession:(key:unknown)=>Promise<void>){}
  setConnected(value:boolean):void{this.#connected=value;if(!value)this.#delegateAll()}
  setEnabled(value:boolean):void{this.#enabled=value;if(!value)this.#delegateAll()}
  close():void{this.#closed=true;this.#delegateAll()}
  read(id:string):PetInteraction|undefined{return this.#pending.get(id)?.request}
  answer(raw:unknown):void {
    const requestId=record(raw)?.requestId;
    const pending=typeof requestId==="string"?this.#pending.get(requestId):undefined;
    if(!pending)throw Error("question no longer pending");
    pending.finish(parsePetAnswer(raw,pending.request));
  }
  async open(ref:string):Promise<void>{
    const key=this.aggregator.sessionKey(ref);if(key===undefined||this.#closed)throw Error("session unavailable");
    await this.openSession(key);
  }
  cancelSession(key:unknown):void{for(const item of this.#pending.values())if(item.key===key)item.abort()}
  async ask(key:unknown,raw:unknown,next:()=>Promise<unknown>):Promise<unknown>{
    if(this.#closed||!this.#connected||!this.#enabled||this.#pending.size>=32)return next();
    const source=record(raw);let request:PetInteraction;
    try{request=parsePetInteraction({interactionVersion:1,requestId:randomUUID(),sessionRef:this.aggregator.sessionInfo(key).ref,questions:source?.questions})}
    catch{return next()}
    const signal=source?.signal as AbortSignal|undefined;
    if(signal?.aborted)throw Error("question cancelled");
    const answer=await new Promise<PetAnswer|undefined>((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{
        this.#pending.delete(request.requestId);signal?.removeEventListener("abort",abort);
        this.aggregator.handleInputResolved(key,request.requestId);
      };
      const finish=(value:PetAnswer|undefined)=>{if(settled)return;settled=true;cleanup();resolve(value)};
      const abort=()=>{if(settled)return;settled=true;cleanup();reject(Error("question cancelled"))};
      this.#pending.set(request.requestId,{key,request,finish,abort});
      signal?.addEventListener("abort",abort,{once:true});
      this.aggregator.handleInputRequested(key,request.requestId);
    });
    return answer?{answers:answer.answers}:next();
  }
  #delegateAll():void{for(const item of this.#pending.values())item.finish(undefined)}
}
function record(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined}
