import { describe, expect, it, vi } from "vitest";
import { InteractionMaskBridge } from "../src/interaction-mask.js";
import { installPointerBehavior } from "../src/pet.js";
import type { ModelHitMask } from "../src/vendor-types.js";

const isModelDrag=(dx:number,dy:number)=>Number.isFinite(dx)&&Number.isFinite(dy)&&Math.hypot(dx,dy)>6;

const mask: ModelHitMask = {width:4,height:2,left:10,top:20,displayWidth:80,displayHeight:40,viewportWidth:100,viewportHeight:100,bits:new Uint8Array([0b00100110])};

describe("model-only pointer interaction", () => {
  it("uses the shared boundary and starts native movement only beyond six CSS pixels",async()=>{
    const listeners=new Map<string,(event:PointerEvent)=>void>(),click=vi.fn();
    const drag={begin:vi.fn(async()=>{}),move:vi.fn(async()=>{}),end:vi.fn(async()=>{})};
    const element={addEventListener:(name:string,fn:(event:PointerEvent)=>void)=>listeners.set(name,fn),setPointerCapture:()=>{},hasPointerCapture:()=>true,releasePointerCapture:()=>{}} as unknown as HTMLElement;
    const classify=vi.fn(isModelDrag),cancel=installPointerBehavior(element,drag,click,()=>true,classify);
    const event=(x:number)=>({button:0,pointerId:1,clientX:x,clientY:25,screenX:x,screenY:25}) as PointerEvent;
    listeners.get("pointerdown")!(event(35));listeners.get("pointermove")!(event(41));
    await Promise.resolve();expect(drag.begin).not.toHaveBeenCalled();
    listeners.get("pointerup")!(event(41));await vi.waitFor(()=>expect(click).toHaveBeenCalledOnce());
    listeners.get("pointerdown")!(event(35));listeners.get("pointermove")!(event(41.01));
    await vi.waitFor(()=>expect(drag.begin).toHaveBeenCalledExactlyOnceWith(35,25));
    listeners.get("pointerup")!(event(35));await vi.waitFor(()=>expect(drag.end).toHaveBeenCalledOnce());
    expect(click).toHaveBeenCalledOnce();expect(classify).toHaveBeenCalledWith(6,0);cancel();
  });
  it.each(["pointercancel","lostpointercapture","blur"])("ends a captured drag on %s and permits the next click",async reason=>{
    const listeners=new Map<string,(event:PointerEvent)=>void>(),click=vi.fn(),release=vi.fn();
    const drag={begin:vi.fn(async()=>{}),move:vi.fn(async()=>{}),end:vi.fn(async()=>{})};
    const element={addEventListener:(name:string,fn:(event:PointerEvent)=>void)=>listeners.set(name,fn),setPointerCapture:()=>{},hasPointerCapture:()=>true,releasePointerCapture:release} as unknown as HTMLElement;
    const cancel=installPointerBehavior(element,drag,click,()=>true,isModelDrag),event=(x:number)=>({button:0,pointerId:1,clientX:x,clientY:25,screenX:x,screenY:25}) as PointerEvent;
    listeners.get("pointerdown")!(event(35));listeners.get("pointermove")!(event(45));
    await vi.waitFor(()=>expect(drag.begin).toHaveBeenCalledOnce());
    if(reason==="blur")cancel();else listeners.get(reason)!(event(45));
    listeners.get("pointerup")!(event(45));await vi.waitFor(()=>expect(drag.end).toHaveBeenCalledOnce());
    expect(click).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
    listeners.get("pointerdown")!(event(35));listeners.get("pointerup")!(event(35));
    await vi.waitFor(()=>expect(click).toHaveBeenCalledOnce());expect(drag.begin).toHaveBeenCalledOnce();cancel();
  });
  it("never enters native drag for short presses or a fast double click",async()=>{
    vi.useFakeTimers();const listeners=new Map<string,(event:PointerEvent)=>void>(),single=vi.fn(),double=vi.fn();
    const drag={begin:vi.fn(async()=>{}),move:vi.fn(async()=>{}),end:vi.fn(async()=>{})};
    const element={addEventListener:(name:string,fn:(event:PointerEvent)=>void)=>listeners.set(name,fn),setPointerCapture:()=>{},hasPointerCapture:()=>true,releasePointerCapture:()=>{}} as unknown as HTMLElement;
    const cancel=installPointerBehavior(element,drag,single,()=>true,isModelDrag,undefined,double),event={button:0,pointerId:1,clientX:35,clientY:25,screenX:35,screenY:25} as PointerEvent;
    try{
      listeners.get("pointerdown")!(event);listeners.get("pointerup")!(event);await vi.advanceTimersByTimeAsync(1);
      listeners.get("pointerdown")!(event);listeners.get("pointerup")!(event);await vi.advanceTimersByTimeAsync(400);
      expect(drag.begin).not.toHaveBeenCalled();expect(drag.move).not.toHaveBeenCalled();expect(drag.end).not.toHaveBeenCalled();
      expect(double).toHaveBeenCalledOnce();expect(single).not.toHaveBeenCalled();
    }finally{cancel();vi.useRealTimers()}
  });
  it("separates double clicks from single interaction and cancels clicks after dragging",async()=>{
    vi.useFakeTimers();
    const listeners=new Map<string,(event:PointerEvent)=>void>(),single=vi.fn(),double=vi.fn();
    const element={addEventListener:(name:string,fn:(event:PointerEvent)=>void)=>listeners.set(name,fn),setPointerCapture:()=>{},hasPointerCapture:()=>true,releasePointerCapture:()=>{}} as unknown as HTMLElement;
    const cancel=installPointerBehavior(element,{begin:async()=>{},move:async()=>{},end:async()=>{}},single,()=>true,isModelDrag,undefined,double);
    const event=(x=35)=>({button:0,pointerId:1,clientX:x,clientY:25,screenX:x,screenY:25}) as PointerEvent;
    const click=async()=>{listeners.get("pointerdown")!(event());listeners.get("pointerup")!(event());await vi.advanceTimersByTimeAsync(1)};
    try{
      await click();await vi.advanceTimersByTimeAsync(150);await click();await vi.advanceTimersByTimeAsync(400);
      expect(double).toHaveBeenCalledOnce();expect(single).not.toHaveBeenCalled();
      await click();await vi.advanceTimersByTimeAsync(350);expect(single).toHaveBeenCalledOnce();
      await click();listeners.get("pointerdown")!(event());listeners.get("pointermove")!(event(55));listeners.get("pointerup")!(event(55));await vi.advanceTimersByTimeAsync(400);expect(single).toHaveBeenCalledOnce();
      await click();cancel();await vi.advanceTimersByTimeAsync(400);expect(single).toHaveBeenCalledOnce();
    }finally{cancel();vi.useRealTimers()}
  });
  it("accepts actual coverage and excludes transparent texture holes and nearby background", () => {
    const bridge = new InteractionMaskBridge(async () => {}, vi.fn());
    bridge.update(mask);
    expect(bridge.hitTest(35,25)).toBe(true);
    expect(bridge.hitTest(15,25)).toBe(false);
    expect(bridge.hitTest(55,55)).toBe(false);
    expect(bridge.hitTest(90,25)).toBe(false);
    expect(bridge.hitTest(NaN,25)).toBe(false);
    bridge.update(undefined); expect(bridge.hitTest(35,25)).toBe(false);
  });
  it("serializes native updates and coalesces pending frames without stale restore", async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => {finish=resolve}));
    const bridge = new InteractionMaskBridge(send,vi.fn());
    bridge.update(mask); bridge.update({...mask,left:20}); bridge.update(undefined);
    expect(send).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(null);
    finish(); await Promise.resolve();
  });
  it("waits for coalesced fresh coverage before permitting a screen sample",async()=>{
    let finish!:()=>void;
    const send=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const bridge=new InteractionMaskBridge(send,vi.fn()),ready=vi.fn();
    bridge.update(mask);bridge.update({...mask,left:30});
    const waiting=bridge.ready().then(ready);
    finish();await Promise.resolve();expect(send).toHaveBeenCalledTimes(2);expect(ready).not.toHaveBeenCalled();
    finish();await waiting;expect(ready).toHaveBeenCalledOnce();
    expect(send).toHaveBeenLastCalledWith({...mask,left:30,bits:Array.from(mask.bits)});
    await bridge.ready();
  });
  it("reuses paused fixed-layout coverage after a native surface resize without filling transparent holes",async()=>{
    const send=vi.fn(async()=>{}),bridge=new InteractionMaskBridge(send,vi.fn());
    bridge.update({...mask,viewportWidth:576,viewportHeight:720});await Promise.resolve();
    bridge.resizeFixedViewport(576,1204);await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({...mask,viewportWidth:576,viewportHeight:1204,bits:Array.from(mask.bits)});
    expect(bridge.hitTest(35,25)).toBe(true);expect(bridge.hitTest(15,25)).toBe(false);
    bridge.resizeFixedViewport(576,1204);bridge.resizeFixedViewport(NaN,1204);
    expect(send).toHaveBeenCalledTimes(2);
    bridge.invalidateForViewport();bridge.resizeFixedViewport(576,720);
    expect(send).toHaveBeenCalledTimes(2);expect(bridge.hitTest(35,25)).toBe(false);
  });
  it("coalesces fixed viewport changes behind an in-flight frame and cannot restore a removed model",async()=>{
    let finish!:()=>void;
    const send=vi.fn(()=>new Promise<void>(done=>{finish=done}));
    const bridge=new InteractionMaskBridge(send,vi.fn());
    bridge.update(mask);bridge.resizeFixedViewport(576,720);bridge.resizeFixedViewport(576,1204);
    expect(send).toHaveBeenCalledOnce();finish();await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({...mask,viewportWidth:576,viewportHeight:1204,bits:Array.from(mask.bits)});
    bridge.update(undefined);bridge.resizeFixedViewport(576,720);finish();await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith(null);finish();await Promise.resolve();
    bridge.resizeFixedViewport(576,1204);expect(send).toHaveBeenCalledTimes(3);
  });
  it("invalidates old viewport coverage without sending a drag-cancelling null mask",async()=>{
    let finish!:()=>void;
    const send=vi.fn(()=>new Promise<void>(done=>{finish=done}));
    const bridge=new InteractionMaskBridge(send,vi.fn());
    bridge.update(mask);bridge.update({...mask,left:20});bridge.invalidateForViewport();
    expect(bridge.hitTest(35,25)).toBe(false);
    finish();await Promise.resolve();expect(send).toHaveBeenCalledOnce();
    bridge.update({...mask,left:30});expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({...mask,left:30,bits:Array.from(mask.bits)});
    finish();await Promise.resolve();
  });
  it("clears local coverage and contains a native failure", async () => {
    const failed=vi.fn(); const bridge=new InteractionMaskBridge(async()=>{throw new Error("IPC unavailable")},failed);
    bridge.update(mask); await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce(); expect(bridge.hitTest(35,25)).toBe(false);
  });
  it("opens settings only when the context click hits the model silhouette", () => {
    const listeners=new Map<string,(event:MouseEvent)=>void>(),open=vi.fn();
    const element={addEventListener:(name:string,listener:(event:MouseEvent)=>void)=>listeners.set(name,listener)} as unknown as HTMLElement;
    installPointerBehavior(element,{begin:async()=>{},move:async()=>{},end:async()=>{}},vi.fn(),x=>x>30,isModelDrag,open);
    const preventDefault=vi.fn();
    listeners.get('contextmenu')!({clientX:15,clientY:25,preventDefault} as unknown as MouseEvent);
    expect(open).not.toHaveBeenCalled();expect(preventDefault).not.toHaveBeenCalled();
    listeners.get('contextmenu')!({clientX:35,clientY:25,preventDefault} as unknown as MouseEvent);
    expect(open).toHaveBeenCalledOnce();expect(preventDefault).toHaveBeenCalledOnce();
  });
  it("does not click or drag from transparent pixels and retains the final rapid drag movement", async () => {
    const listeners = new Map<string,(event:PointerEvent)=>void>();
    const capture=vi.fn(),release=vi.fn(),click=vi.fn();
    const drag={begin:vi.fn(async()=>{}),move:vi.fn(async()=>{}),end:vi.fn(async()=>{})};
    const element={addEventListener:(name:string,listener:(event:PointerEvent)=>void)=>listeners.set(name,listener),setPointerCapture:capture,hasPointerCapture:()=>true,releasePointerCapture:release} as unknown as HTMLElement;
    const hit=(x:number)=>x>30;
    installPointerBehavior(element,drag,click,hit,isModelDrag);
    const event=(x:number)=>({button:0,pointerId:1,clientX:x,clientY:25,screenX:x,screenY:25}) as PointerEvent;
    listeners.get("pointerdown")!(event(15)); listeners.get("pointermove")!(event(80)); listeners.get("pointerup")!(event(80));
    expect(capture).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect(drag.begin).not.toHaveBeenCalled();
    listeners.get("pointerdown")!(event(35));listeners.get("pointerup")!(event(35));
    await vi.waitFor(()=>expect(click).toHaveBeenCalledOnce());expect(drag.begin).not.toHaveBeenCalled();expect(drag.end).not.toHaveBeenCalled();
    listeners.get("pointerdown")!(event(35));listeners.get("pointermove")!(event(45));listeners.get("pointerup")!(event(45));
    await vi.waitFor(()=>expect(drag.end).toHaveBeenCalledOnce());
    expect(drag.move).toHaveBeenCalledTimes(2);expect(click).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledTimes(2);
  });
});
