import {parseControlFrame, type ControlAck, type ControlFrame, type ControlRelease, type ControlStage} from "@starcried/starlite-dsh-protocol";
import type {AnimationPlaybackResult} from "./vendor-types.js";

export interface SessionOwner {leaseId:string; title:string}
export interface SessionPresentation {
  available():boolean;
  textAllowed():boolean;
  animations():readonly {name:string;durationMs:number}[];
  enter(signal:AbortSignal):Promise<void>;
  leave(restorePosition:boolean):Promise<void>;
  idle():void;
  play(name:string):Promise<AnimationPlaybackResult>;
  stop():void;
  bubble(text:string|undefined,title?:string):void;
  stage(value:ControlStage,signal:AbortSignal):Promise<void>;
  changed(owner:SessionOwner|undefined):void;
  ack(value:ControlAck):Promise<void>;
  release(value:ControlRelease):Promise<void>;
}
type Pending={frame:ControlFrame;abort:AbortController};

/** One leased presentation lane, independent of automatic DSH state animation.
 * Commands never accumulate: a performance replaces its predecessor; geometry
 * accepts one in-flight operation. No session content is persisted or logged. */
export class SessionPresenter {
  #owner:SessionOwner|undefined;
  #ready=false;
  #restoring:Promise<void>|undefined;
  #acquire:Pending|undefined;
  #stage:Pending|undefined;
  #performance:Pending|undefined;
  #bubbleTimer:ReturnType<typeof setTimeout>|undefined;
  #bubbleOwner:Pending|undefined;
  #leaseTimer:ReturnType<typeof setTimeout>|undefined;
  #lastSequence=-1;
  #seen=new Set<string>();
  constructor(readonly view:SessionPresentation){}
  get owner():SessionOwner|undefined{return this.#owner;}
  get busy():boolean{return Boolean(this.#owner||this.#restoring);}
  get restoring():boolean{return Boolean(this.#restoring);}

  receive(input:ControlFrame):void {
    // Validate again at the presentation boundary; native/tests cannot bypass
    // finite bounds or smuggle arbitrary fields through a typed caller.
    let frame:ControlFrame;
    try{frame=parseControlFrame(input);}catch{return;}
    if(frame.sequence<=this.#lastSequence||this.#seen.has(frame.commandId))return;
    this.#lastSequence=frame.sequence;this.#seen.add(frame.commandId);
    if(this.#seen.size>128)this.#seen.delete(this.#seen.values().next().value!);
    if(frame.kind==="acquire"){
      if(this.#owner?.leaseId===frame.leaseId&&this.#ready&&this.view.available()){
        this.#owner={leaseId:frame.leaseId,title:frame.sessionTitle};this.#renew(frame.leaseMs);
        this.view.changed(this.#owner);this.#ack(frame,"started");this.#ack(frame,"completed");return;
      }
      if(this.busy||!this.view.available()){this.#ack(frame,"rejected","unavailable");return;}
      this.#owner={leaseId:frame.leaseId,title:frame.sessionTitle};
      const pending={frame,abort:new AbortController()};this.#acquire=pending;
      this.#renew(frame.leaseMs);this.view.changed(this.#owner);
      void this.view.enter(pending.abort.signal).then(()=>{
        if(this.#acquire!==pending||pending.abort.signal.aborted)return;
        this.#acquire=undefined;this.#ready=true;this.view.idle();
        this.#ack(frame,"started");this.#ack(frame,"completed");
      },()=>{
        if(this.#acquire!==pending)return;
        this.#acquire=undefined;this.#ack(frame,"rejected","failed");void this.release("unavailable");
      });
      return;
    }
    if(!this.#owner||frame.leaseId!==this.#owner.leaseId){this.#ack(frame,"rejected","stale");return;}
    if(frame.kind==="release"){
      void this.#end(undefined,true).then(()=>this.#ack(frame,"completed"));return;
    }
    if(frame.kind==="cancel"){
      if(this.#acquire?.frame.commandId===frame.targetId||this.#stage?.frame.commandId===frame.targetId){
        void this.#end(undefined,true).then(()=>this.#ack(frame,"completed"));
      }else{
        if(this.#performance?.frame.commandId===frame.targetId){this.#interrupt("interrupted");this.view.idle();}
        this.#ack(frame,"completed");
      }
      return;
    }
    if(!this.#ready||!this.view.available()){this.#ack(frame,"rejected","unavailable");return;}
    this.#renew(frame.leaseMs);
    if(frame.kind==="perform"){
      if(frame.animation&&!this.view.animations().some(clip=>clip.name===frame.animation)){
        this.#ack(frame,"rejected","unknown-animation");return;
      }
      if(frame.text&&!this.view.textAllowed()){this.#ack(frame,"rejected","user-preference");return;}
      this.#interrupt("interrupted",!frame.animation);
      if(frame.stop){this.view.idle();this.#ack(frame,"stopped");return;}
      const pending={frame,abort:new AbortController()};this.#performance=pending;
      // Start both in this task. A stale animation completion cannot clear or
      // replace the newer performance's text or its idle return.
      let playback:Promise<AnimationPlaybackResult>|undefined;
      try{if(frame.animation)playback=this.view.play(frame.animation);}
      catch{this.#performance=undefined;this.#ack(frame,"rejected","failed");this.view.idle();return;}
      if(!frame.animation)this.view.idle();
      if(frame.text){
        this.#bubbleOwner=pending;
        this.view.bubble(frame.text,this.#owner.title);
        this.#bubbleTimer=setTimeout(()=>{
          this.#bubbleTimer=undefined;
          if(this.#bubbleOwner!==pending||pending.abort.signal.aborted)return;
          this.#bubbleOwner=undefined;
          this.view.bubble(undefined);
          if(!frame.animation){this.#performance=undefined;this.#ack(frame,"completed");}
        },frame.durationMs??6000);
      }
      this.#ack(frame,"started");
      if(playback)void playback.then(result=>{
        if(this.#performance!==pending||pending.abort.signal.aborted)return;
        this.#performance=undefined;if(result!=="completed")this.#clearBubble();this.view.idle();this.#ack(frame,result);
      },()=>{
        if(this.#performance!==pending)return;
        this.#performance=undefined;this.#clearBubble();this.view.idle();this.#ack(frame,"rejected","failed");
      });
      return;
    }
    if(this.#stage){this.#ack(frame,"rejected","unavailable");return;}
    const pending={frame,abort:new AbortController()};this.#stage=pending;
    const stage:ControlStage={...(frame.position?{position:frame.position}:{}),...(frame.scale===undefined?{}:{scale:frame.scale}),...(frame.pointerEnabled===undefined?{}:{pointerEnabled:frame.pointerEnabled})};
    this.#ack(frame,"started");
    void this.view.stage(stage,pending.abort.signal).then(()=>{
      if(this.#stage!==pending||pending.abort.signal.aborted)return;
      this.#stage=undefined;this.#ack(frame,"completed");
    },()=>{
      if(this.#stage!==pending)return;
      this.#stage=undefined;this.#ack(frame,"rejected","failed");void this.release("unavailable");
    });
  }

  /** Manual input ends ownership before applying the user's change. */
  release(reason:ControlRelease["reason"]="user",restorePosition=true):Promise<void>{return this.#end(reason,restorePosition);}
  disconnect():void {void this.#end(undefined,true);this.#lastSequence=-1;this.#seen.clear();}
  #end(reason:ControlRelease["reason"]|undefined,restorePosition:boolean):Promise<void>{
    if(!this.#owner)return this.#restoring??Promise.resolve();
    const owner=this.#owner;this.#owner=undefined;this.#ready=false;
    if(this.#leaseTimer!==undefined)clearTimeout(this.#leaseTimer);this.#leaseTimer=undefined;
    for(const pending of [this.#acquire,this.#stage])if(pending){pending.abort.abort();this.#ack(pending.frame,"interrupted");}
    this.#acquire=undefined;this.#stage=undefined;
    this.#interrupt("interrupted");
    // Establish restoring before callbacks, so snapshot/availability paths do
    // not restart automatic animation until temporary geometry is cleared.
    const leave=Promise.resolve().then(()=>this.view.leave(restorePosition)).catch(()=>{});
    this.#restoring=leave;
    this.view.changed(undefined);
    if(reason)void this.view.release({leaseId:owner.leaseId,reason}).catch(()=>{});
    return leave.finally(()=>{
      if(this.#restoring===leave){this.#restoring=undefined;this.view.changed(undefined);}
    });
  }
  #interrupt(status:"interrupted"|"stopped",stop=true):void{
    const pending=this.#performance;this.#performance=undefined;
    if(pending){pending.abort.abort();this.#ack(pending.frame,status);}
    if(stop)this.view.stop();this.#clearBubble();
  }
  #clearBubble():void{if(this.#bubbleTimer!==undefined)clearTimeout(this.#bubbleTimer);this.#bubbleTimer=undefined;this.#bubbleOwner=undefined;this.view.bubble(undefined);}
  #renew(ms:number):void{if(this.#leaseTimer!==undefined)clearTimeout(this.#leaseTimer);this.#leaseTimer=setTimeout(()=>{void this.release("unavailable");},ms);}
  #ack(frame:ControlFrame,status:ControlAck["status"],reason?:ControlAck["reason"]):void{
    void this.view.ack({controlVersion:1,leaseId:frame.leaseId,commandId:frame.commandId,status,...(reason?{reason}:{})}).catch(()=>{});
  }
}
