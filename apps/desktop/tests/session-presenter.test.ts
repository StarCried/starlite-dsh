import {afterEach,expect,it,vi} from "vitest";
import {CONTROL_LEASE_MS,type ControlFrame} from "@starcried/starlite-dsh-protocol";
import {SessionPresenter,type SessionPresentation} from "../src/session-presenter.js";
import type {AnimationPlaybackResult} from "../src/vendor-types.js";

const leaseId="123e4567-e89b-42d3-a456-426614174000";
let sequence=0;
type Command=({kind:"acquire";sessionTitle:string}|{kind:"perform";animation?:string;text?:string;durationMs?:number;stop?:true}|{kind:"stage";scale?:number;pointerEnabled?:boolean;position?:{x:number;y:number}}|{kind:"cancel";targetId:string}|{kind:"release";reason:"user"});
const frame=(value:Command):ControlFrame=>({controlVersion:1,sequence:++sequence,leaseId,commandId:`123e4567-e89b-42d3-a456-${String(sequence).padStart(12,"0")}`,leaseMs:CONTROL_LEASE_MS,...value});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function fixture(){
  vi.useFakeTimers();sequence=0;
  const playbacks:ReturnType<typeof deferred<AnimationPlaybackResult>>[]=[];
  const view:SessionPresentation={available:vi.fn(()=>true),textAllowed:vi.fn(()=>true),animations:()=>[{name:"Wave",durationMs:1200},{name:"Nod",durationMs:900}],
    enter:vi.fn(async()=>{}),leave:vi.fn(async()=>{}),idle:vi.fn(),stop:vi.fn(),
    play:vi.fn(()=>{const playback=deferred<AnimationPlaybackResult>();playbacks.push(playback);return playback.promise;}),
    bubble:vi.fn(),stage:vi.fn(async()=>{}),changed:vi.fn(),ack:vi.fn(async()=>{}),release:vi.fn(async()=>{})};
  const presenter=new SessionPresenter(view);
  const acquire=async()=>{presenter.receive(frame({kind:"acquire",sessionTitle:"Test session"}));await Promise.resolve();};
  return{view,presenter,playbacks,acquire};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

it("starts text and named motion together, keeps text for its requested lifetime, and returns to idle",async()=>{
  const f=fixture();await f.acquire();
  const command=frame({kind:"perform",animation:"Wave",text:"Hello <b>plain</b>",durationMs:5000});f.presenter.receive(command);
  expect(f.view.play).toHaveBeenCalledWith("Wave");expect(f.view.bubble).toHaveBeenLastCalledWith("Hello <b>plain</b>","Test session");
  expect(f.view.ack).toHaveBeenLastCalledWith(expect.objectContaining({commandId:command.commandId,status:"started"}));
  f.playbacks[0]!.resolve("completed");await Promise.resolve();
  expect(f.view.idle).toHaveBeenCalledTimes(2);expect(f.view.bubble).toHaveBeenLastCalledWith("Hello <b>plain</b>","Test session");
  await vi.advanceTimersByTimeAsync(5000);expect(f.view.bubble).toHaveBeenLastCalledWith(undefined);
});
it("interrupts replaced playback exactly once and ignores its late completion and timer",async()=>{
  const f=fixture();await f.acquire();
  const old=frame({kind:"perform",animation:"Wave",text:"old",durationMs:1000});f.presenter.receive(old);
  const current=frame({kind:"perform",animation:"Nod",text:"current",durationMs:5000});f.presenter.receive(current);
  const calls=vi.mocked(f.view.ack).mock.calls.filter(([value])=>value.commandId===old.commandId);
  expect(calls.map(([value])=>value.status)).toEqual(["started","interrupted"]);
  f.playbacks[0]!.resolve("completed");await vi.advanceTimersByTimeAsync(1500);
  expect(f.view.bubble).toHaveBeenLastCalledWith("current","Test session");expect(f.view.idle).toHaveBeenCalledOnce();
  expect(f.view.stop).not.toHaveBeenCalled(); // Runtime blends the replacement directly.
  f.playbacks[1]!.resolve("completed");await Promise.resolve();
  expect(f.view.ack).toHaveBeenLastCalledWith(expect.objectContaining({commandId:current.commandId,status:"completed"}));
});
it("deduplicates frames and renews the same owner without recapturing the baseline",async()=>{
  const f=fixture();await f.acquire();
  const current=frame({kind:"perform",animation:"Wave"});f.presenter.receive(current);f.presenter.receive(current);
  f.presenter.receive({...current,sequence:0});
  f.presenter.receive(frame({kind:"acquire",sessionTitle:"Renamed"}));
  expect(f.view.play).toHaveBeenCalledOnce();expect(f.view.enter).toHaveBeenCalledOnce();
  expect(f.presenter.owner?.title).toBe("Renamed");expect(f.view.stop).not.toHaveBeenCalled();
});
it("keeps idle running for text-only presentation after interrupting a foreground action",async()=>{
  const f=fixture();await f.acquire();f.presenter.receive(frame({kind:"perform",animation:"Wave"}));
  const text=frame({kind:"perform",text:"Just talking",durationMs:1200});f.presenter.receive(text);
  expect(f.view.stop).toHaveBeenCalledOnce();expect(f.view.idle).toHaveBeenCalledTimes(2);
  f.playbacks[0]!.resolve("interrupted");await vi.advanceTimersByTimeAsync(1200);
  expect(f.view.ack).toHaveBeenLastCalledWith(expect.objectContaining({commandId:text.commandId,status:"completed"}));
  expect(f.view.idle).toHaveBeenCalledTimes(2);
});
it("rejects missing animations, hidden text and nonfinite geometry without disrupting the current performance",async()=>{
  const f=fixture();await f.acquire();f.presenter.receive(frame({kind:"perform",animation:"Wave"}));
  f.presenter.receive(frame({kind:"perform",animation:"wave",text:"bad"}));
  expect(f.view.ack).toHaveBeenLastCalledWith(expect.objectContaining({status:"rejected",reason:"unknown-animation"}));
  vi.mocked(f.view.textAllowed).mockReturnValue(false);
  f.presenter.receive(frame({kind:"perform",animation:"Nod",text:"private"}));
  expect(f.view.ack).toHaveBeenLastCalledWith(expect.objectContaining({status:"rejected",reason:"user-preference"}));
  f.presenter.receive(frame({kind:"stage",scale:Number.NaN}));
  expect(f.view.stage).not.toHaveBeenCalled();expect(f.view.play).toHaveBeenCalledOnce();
});
it("aborts in-flight geometry on manual override and refuses a new owner while restoration is pending",async()=>{
  const f=fixture();await f.acquire();
  const stage=deferred<void>(),leave=deferred<void>();vi.mocked(f.view.stage).mockReturnValue(stage.promise);vi.mocked(f.view.leave).mockReturnValue(leave.promise);
  const first=frame({kind:"stage",scale:.8,position:{x:.2,y:.8}});f.presenter.receive(first);
  f.presenter.receive(frame({kind:"stage",scale:1}));expect(f.view.stage).toHaveBeenCalledOnce();
  const done=f.presenter.release("user",false);await Promise.resolve();
  expect(vi.mocked(f.view.stage).mock.calls[0]![1].aborted).toBe(true);expect(f.view.leave).toHaveBeenCalledWith(false);
  expect(f.presenter.busy).toBe(true);expect(f.presenter.owner).toBeUndefined();
  f.presenter.receive(frame({kind:"acquire",sessionTitle:"Too soon"}));expect(f.view.enter).toHaveBeenCalledOnce();
  stage.resolve();await Promise.resolve();
  expect(vi.mocked(f.view.ack).mock.calls.filter(([a])=>a.commandId===first.commandId).map(([a])=>a.status)).toEqual(["started","interrupted"]);
  leave.resolve();await done;expect(f.presenter.busy).toBe(false);
});
it("returns to automatic mode on tool cancellation, lease expiry and disconnected transport",async()=>{
  const f=fixture();await f.acquire();
  const animation=frame({kind:"perform",animation:"Wave"});f.presenter.receive(animation);
  f.presenter.receive(frame({kind:"cancel",targetId:animation.commandId}));
  expect(f.view.idle).toHaveBeenCalledTimes(2);expect(f.presenter.owner).toBeDefined();
  await vi.advanceTimersByTimeAsync(CONTROL_LEASE_MS);
  expect(f.presenter.busy).toBe(false);expect(f.view.release).toHaveBeenCalledWith({leaseId,reason:"unavailable"});
  await f.acquire();f.presenter.receive(frame({kind:"perform",text:"Hello"}));f.presenter.disconnect();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(f.presenter.owner).toBeUndefined();expect(f.view.bubble).toHaveBeenLastCalledWith(undefined);
  f.playbacks[0]!.resolve("completed");await Promise.resolve();expect(f.presenter.owner).toBeUndefined();
});
it("cannot resurrect a cancelled acquire when native baseline capture finishes late",async()=>{
  const f=fixture(),capture=deferred<void>();vi.mocked(f.view.enter).mockReturnValue(capture.promise);
  const acquire=frame({kind:"acquire",sessionTitle:"Aborted"});f.presenter.receive(acquire);
  const done=f.presenter.release("user");capture.resolve();await done;
  expect(f.presenter.busy).toBe(false);expect(f.view.idle).not.toHaveBeenCalled();
  expect(vi.mocked(f.view.enter).mock.calls[0]![0].aborted).toBe(true);
  expect(vi.mocked(f.view.ack).mock.calls.filter(([a])=>a.commandId===acquire.commandId).map(([a])=>a.status)).toEqual(["interrupted"]);
});
