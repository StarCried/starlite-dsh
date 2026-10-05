import { describe, expect, it, vi } from "vitest";
import { InteractionMaskBridge } from "../src/interaction-mask.js";
import { installPointerBehavior } from "../src/pet.js";
import type { ModelHitMask } from "../src/vendor-types.js";

const mask: ModelHitMask = {width:4,height:2,left:10,top:20,displayWidth:80,displayHeight:40,viewportWidth:100,viewportHeight:100,bits:new Uint8Array([0b00100110])};

describe("model-only pointer interaction", () => {
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
  it("clears local coverage and contains a native failure", async () => {
    const failed=vi.fn(); const bridge=new InteractionMaskBridge(async()=>{throw new Error("IPC unavailable")},failed);
    bridge.update(mask); await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce(); expect(bridge.hitTest(35,25)).toBe(false);
  });
  it("does not click or drag from transparent pixels and retains the final rapid drag movement", async () => {
    const listeners = new Map<string,(event:PointerEvent)=>void>();
    const capture=vi.fn(),release=vi.fn(),click=vi.fn();
    const drag={begin:vi.fn(async()=>{}),move:vi.fn(async()=>{}),end:vi.fn(async()=>{})};
    const element={addEventListener:(name:string,listener:(event:PointerEvent)=>void)=>listeners.set(name,listener),setPointerCapture:capture,hasPointerCapture:()=>true,releasePointerCapture:release} as unknown as HTMLElement;
    const hit=(x:number)=>x>30;
    installPointerBehavior(element,drag,click,hit);
    const event=(x:number)=>({button:0,pointerId:1,clientX:x,clientY:25,screenX:x,screenY:25}) as PointerEvent;
    listeners.get("pointerdown")!(event(15)); listeners.get("pointermove")!(event(80)); listeners.get("pointerup")!(event(80));
    expect(capture).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect(drag.begin).not.toHaveBeenCalled();
    listeners.get("pointerdown")!(event(35));listeners.get("pointerup")!(event(35));
    await vi.waitFor(()=>expect(drag.end).toHaveBeenCalledOnce());expect(click).toHaveBeenCalledOnce();
    listeners.get("pointerdown")!(event(35));listeners.get("pointermove")!(event(45));listeners.get("pointerup")!(event(45));
    await vi.waitFor(()=>expect(drag.end).toHaveBeenCalledTimes(2));
    expect(drag.move).toHaveBeenCalledTimes(2);expect(click).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledTimes(2);
  });
});
