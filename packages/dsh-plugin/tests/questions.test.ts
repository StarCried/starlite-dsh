import {expect,it,vi} from "vitest";
import {DshStateAggregator} from "../src/aggregator.js";
import {QuestionBridge} from "../src/questions.js";
import type {PetSnapshot} from "@starcried/starlite-dsh-protocol";
async function fixture(){const snapshots:PetSnapshot[]=[];const aggregator=new DshStateAggregator();await aggregator.start(s=>snapshots.push(s));const open=vi.fn(async()=>{}),bridge=new QuestionBridge(aggregator,open);bridge.setConnected(true);bridge.setEnabled(true);return {bridge,aggregator,snapshots,open}}
const questions=[{id:"q",question:"Pick",options:[{label:"Yes"},{label:"No"}]}];
it("answers the exact pending request once without forwarding identity or arguments",async()=>{
 const f=await fixture(),key={id:"PRIVATE-ID"};f.aggregator.sessionInfo(key,"Named task");
 const next=vi.fn(async()=>({answers:[]}));const answer=f.bridge.ask(key,{questions,agent:{id:"PRIVATE-ID"},arguments:{secret:"PRIVATE"}},next);
 const snapshot=f.snapshots.at(-1)!;expect(snapshot.activity).toBe("waiting");expect(snapshot.session?.title).toBe("Named task");
 const request=f.bridge.read(snapshot.inputRequest!)!;expect(JSON.stringify(request)).not.toContain("PRIVATE");
 await f.bridge.answer({requestId:request.requestId,sessionRef:request.sessionRef,answers:[{id:"q",selected:["Yes"]}]});
 expect(await answer).toEqual({answers:[{id:"q",selected:["Yes"]}]});expect(next).not.toHaveBeenCalled();
 await expect(f.bridge.answer({requestId:request.requestId,sessionRef:request.sessionRef,answers:[]})).rejects.toThrow();await f.aggregator.stop();
});
it("delegates when unavailable, privacy-disabled or disconnected without stranding DSH",async()=>{
 const f=await fixture(),next=vi.fn(async()=>"web-answer");f.bridge.setEnabled(false);expect(await f.bridge.ask("A",{questions},next)).toBe("web-answer");
 f.bridge.setEnabled(true);const waiting=f.bridge.ask("A",{questions},next);f.bridge.setConnected(false);expect(await waiting).toBe("web-answer");expect(next).toHaveBeenCalledTimes(2);await f.aggregator.stop();
});
it("cancels an aborted question and rejects stale or cross-session answers",async()=>{
 const f=await fixture(),abort=new AbortController();const waiting=f.bridge.ask("A",{questions,signal:abort.signal},async()=>"wrong");const caught=waiting.catch(()=>"cancelled");
 const a=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;const b=f.bridge.ask("B",{questions},async()=>"web");const br=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 await expect(f.bridge.answer({...a,sessionRef:br.sessionRef,answers:[{id:"q",selected:["Yes"]}]})).rejects.toThrow();abort.abort();expect(await caught).toBe("cancelled");expect(f.bridge.read(a.requestId)).toBeUndefined();
 await f.bridge.answer({requestId:br.requestId,sessionRef:br.sessionRef,answers:[{id:"q",selected:[],custom:"custom"}]});expect(await b).toEqual({answers:[{id:"q",selected:[],custom:"custom"}]});await f.aggregator.stop();
});
it("uses the selected reference for navigation and retires it on disposal",async()=>{
 const f=await fixture(),a={},b={};const ref=f.aggregator.sessionInfo(a,"A").ref;f.aggregator.sessionInfo(b,"B");await f.bridge.open(ref);expect(f.open).toHaveBeenCalledWith(a);
 f.aggregator.disposeSession(a);await expect(f.bridge.open(ref)).rejects.toThrow();await f.aggregator.stop();
});
it("opens home explicitly without recovering stale sessions or navigating after close",async()=>{
 const f=await fixture(),key={id:"private"},ref=f.aggregator.sessionInfo(key).ref;
 await f.bridge.openWebUi();expect(f.open).toHaveBeenCalledExactlyOnceWith(undefined);
 f.aggregator.disposeSession(key);await expect(f.bridge.open(ref)).rejects.toThrow("session unavailable");
 await expect(f.bridge.open("invalid")).rejects.toThrow("session unavailable");expect(f.open).toHaveBeenCalledOnce();
 f.bridge.close();await expect(f.bridge.openWebUi()).rejects.toThrow("Web UI unavailable");expect(f.open).toHaveBeenCalledOnce();await f.aggregator.stop();
});
it("preserves a blocking question when navigation fails so it can still be answered",async()=>{
 const f=await fixture(),key={id:"PRIVATE"},next=vi.fn(async()=>"official");
 const waiting=f.bridge.ask(key,{questions},next),request=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 f.open.mockRejectedValueOnce(Error("navigation failed"));
 await expect(f.bridge.open(request.sessionRef)).rejects.toThrow("navigation failed");
 expect(f.bridge.read(request.requestId)).toBe(request);expect(next).not.toHaveBeenCalled();
 await f.bridge.answer({...request,answers:[{id:"q",selected:["Yes"]}]});
 await expect(waiting).resolves.toEqual({answers:[{id:"q",selected:["Yes"]}]});f.bridge.close();await f.aggregator.stop();
});
it("delegates a captured blocking question only after successful navigation",async()=>{
 const f=await fixture(),key={id:"PRIVATE"},next=vi.fn(async()=>"official");let finish!:()=>void;
 const waiting=f.bridge.ask(key,{questions},next),request=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 f.open.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const navigating=f.bridge.open(request.sessionRef);
 expect(f.bridge.read(request.requestId)).toBe(request);expect(next).not.toHaveBeenCalled();
 finish();await navigating;await expect(waiting).resolves.toBe("official");
 expect(next).toHaveBeenCalledOnce();expect(f.bridge.read(request.requestId)).toBeUndefined();f.bridge.close();await f.aggregator.stop();
});
it("does not let an old navigation cancel newer questions in the same or another session",async()=>{
 const f=await fixture(),key={id:"PRIVATE"};let finish!:()=>void;
 const first=f.bridge.ask(key,{questions},async()=>"official-old"),old=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 f.open.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));const navigating=f.bridge.open(old.sessionRef);
 await f.bridge.answer({...old,answers:[{id:"q",selected:["Yes"]}]});await first;
 const next=vi.fn(async()=>"wrong"),newWaiting=f.bridge.ask(key,{questions},next),newRequest=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 const otherWaiting=f.bridge.ask({}, {questions},next),other=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 finish();await navigating;
 expect(f.bridge.read(newRequest.requestId)).toBe(newRequest);expect(f.bridge.read(other.requestId)).toBe(other);expect(next).not.toHaveBeenCalled();
 for(const request of [newRequest,other])await f.bridge.answer({...request,answers:[{id:"q",selected:["Yes"]}]});
 await Promise.all([newWaiting,otherWaiting]);f.bridge.close();await f.aggregator.stop();
});
it.each(["close","dispose"])("does not mutate a retired question after navigation settles (%s)",async reason=>{
 const f=await fixture(),key={id:"PRIVATE"};let finish!:()=>void;
 const waiting=f.bridge.ask(key,{questions},async()=>"official");const caught=waiting.catch(()=>"cancelled"),request=f.bridge.read(f.snapshots.at(-1)!.inputRequest!)!;
 f.open.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));const navigating=f.bridge.open(request.sessionRef);
 if(reason==="close")f.bridge.close();else{f.bridge.cancelSession(key);f.aggregator.disposeSession(key);}
 await caught;const count=f.snapshots.length;finish();await navigating;expect(f.snapshots).toHaveLength(count);expect(f.bridge.read(request.requestId)).toBeUndefined();
 f.bridge.close();await f.aggregator.stop();
});
