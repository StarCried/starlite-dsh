// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ModelViewportBridge,type ModelViewport} from "../src/model-viewport.js";

const expanded:ModelViewport={left:-64,top:-96,width:448,height:608,baseWidth:320,baseHeight:480};
let host:HTMLElement,anchor:HTMLElement,surface:HTMLElement,bubble:HTMLElement;
beforeEach(()=>{
  document.body.innerHTML='<main id="pet-view"><div id="model"><div id="surface"></div></div><output id="bubble"></output></main>';
  host=document.getElementById("model")!;anchor=document.getElementById("pet-view")!;surface=document.getElementById("surface")!;
  bubble=document.getElementById("bubble")!;
});
afterEach(()=>vi.unstubAllGlobals());
const event=(value:unknown)=>surface.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true,detail:value}));

it("receives the first mount event and keeps model size, bubble width and screen anchor stable",async()=>{
  const send=vi.fn(async()=>{}),applied=vi.fn(),invalidate=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,applied,vi.fn(),bubble);
  await bridge.configure(true);
  event(expanded);await bridge.ready();
  expect(send).toHaveBeenLastCalledWith(expanded);
  expect(anchor.style.getPropertyValue("--model-width")).toBe("320px");
  expect(anchor.style.getPropertyValue("--model-height")).toBe("480px");
  expect(anchor.style.getPropertyValue("--model-left")).toBe("64px");
  expect(anchor.style.getPropertyValue("--model-top")).toBe("96px");
  expect(anchor.style.getPropertyValue("--bubble-left")).toBe("224px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("12px");
  expect(anchor.style.getPropertyValue("--bubble-width")).toBe("288px");
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("432px");
  expect(bridge.hostPosition({x:120,y:220},1.25)).toEqual({x:160,y:272});
  expect(invalidate).toHaveBeenCalledTimes(2);expect(applied).toHaveBeenCalledTimes(2);
  event({...expanded,left:-96,width:480});await bridge.ready();
  // A corresponding native left shift has no HostMotion displacement.
  expect(bridge.hostPosition({x:80,y:220},1.25)).toEqual({x:160,y:272});
  expect(anchor.style.getPropertyValue("--bubble-width")).toBe("288px");
});

it("does not forward intermediate viewport moves while native resize is pending",async()=>{
  const finish:Array<()=>void>=[],applied=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,()=>new Promise<void>(done=>finish.push(done)),vi.fn(),applied,vi.fn(),bubble);
  const initial=bridge.configure(true);event(expanded);
  expect(bridge.pending).toBe(true);expect(finish).toHaveLength(2);
  finish[0]!();await initial;expect(bridge.pending).toBe(true);expect(applied).not.toHaveBeenCalled();
  finish[1]!();await bridge.ready();expect(bridge.pending).toBe(false);expect(applied).toHaveBeenCalledOnce();
});

it("restores geometry on remount and teardown and leaves Inochi2D unchanged",async()=>{
  const send=vi.fn(async()=>{});const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(false);event(expanded);expect(send).not.toHaveBeenCalled();
  await bridge.configure(true);event(expanded);await bridge.ready();
  await bridge.configure(true);
  expect(anchor.style.getPropertyValue("--model-left")).toBe("0px");
  event(expanded);await bridge.ready();await bridge.configure(false);
  expect(send).toHaveBeenLastCalledWith(null);expect(anchor.classList.contains("vrm-viewport")).toBe(false);
  expect(anchor.style.getPropertyValue("--bubble-width")).toBe("");
  const count=send.mock.calls.length;event(expanded);expect(send).toHaveBeenCalledTimes(count);
  await bridge.configure(true);event(expanded);await bridge.ready();await bridge.destroy();
  expect(send).toHaveBeenLastCalledWith(null);
  event(expanded);expect(send).toHaveBeenLastCalledWith(null);
});

it("ignores detached old mounts and contains invalid or failed native viewport updates",async()=>{
  const send=vi.fn(async()=>{}),failed=vi.fn();const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),failed,bubble);
  await bridge.configure(true);
  const old=surface;surface=document.createElement("div");host.replaceChildren(surface);
  old.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true,detail:expanded}));
  expect(send).toHaveBeenCalledOnce();
  for(const value of [{...expanded,width:Infinity},{...expanded,left:10},{...expanded,width:350},{...expanded,baseWidth:640}])event(value);
  expect(failed).toHaveBeenCalledTimes(4);expect(send).toHaveBeenCalledOnce();
  send.mockRejectedValueOnce(new Error("native unavailable"));event(expanded);
  await expect(bridge.ready()).rejects.toThrow("native unavailable");
  expect(failed).toHaveBeenCalledTimes(5);expect(bridge.pending).toBe(false);
});

it("keeps compact, billing and input bubbles above the whole drawing surface at fractional DPI",async()=>{
  let resized=()=>{},height=62;
  const disconnect=vi.fn();
  vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){disconnect();}});
  vi.spyOn(bubble,"getBoundingClientRect").mockImplementation(()=>({height}) as DOMRect);
  const send=vi.fn(async(_value:ModelViewport|null)=>{}),invalidate=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);event(expanded);await bridge.ready();
  let previous=send.mock.calls.at(-1)![0]!;
  let windowTop=Math.round(previous.top*1.25)+300;
  for (const nextHeight of [62,120,432,62]) {
    height=nextHeight;resized();await bridge.ready();
    const native=send.mock.calls.at(-1)![0]!;
    windowTop+=Math.round(native.top*1.25)-Math.round(previous.top*1.25);
    expect(bridge.hostPosition({x:0,y:windowTop},1.25).y).toBe(240);
    expect(native.height+native.top).toBe(expanded.height+expanded.top);
    expect(anchor.style.getPropertyValue("--model-height")).toBe("480px");
    const modelTop=Number.parseFloat(anchor.style.getPropertyValue("--model-top"));
    const bubbleTop=Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"));
    // Drawing padding can contain an ear or raised hand; even its upper edge
    // remains below the bubble and its 9px speech tail.
    expect(modelTop+expanded.top-(bubbleTop+height+9)).toBe(15);
    expect(bubbleTop).toBeGreaterThanOrEqual(0);
    previous=native;
  }
  bubble.hidden=true;await vi.waitFor(()=>expect(send).toHaveBeenLastCalledWith(expanded));
  expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  const calls=send.mock.calls.length;await bridge.destroy();height=100;resized();await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(calls+1);expect(send).toHaveBeenLastCalledWith(null);expect(disconnect).toHaveBeenCalledOnce();
});

it("does not alter Inochi2D geometry when a bubble changes size",async()=>{
  let resized=()=>{};
  vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});
  vi.spyOn(bubble,"getBoundingClientRect").mockReturnValue({height:160} as DOMRect);
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(false);resized();await bridge.ready();
  expect(send).not.toHaveBeenCalled();expect(anchor.style.getPropertyValue("--model-top")).toBe("");
  await bridge.destroy();
});

it("scrolls a tall question into the available screen space without moving the model",async()=>{
  bubble.dataset.interactive="true";
  vi.spyOn(bubble,"getBoundingClientRect").mockImplementation(()=>({height:Math.min(700,Number.parseFloat(anchor.style.getPropertyValue("--bubble-max-height"))||700)}) as DOMRect);
  const send=vi.fn(async(_value:ModelViewport|null)=>{});
  const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  bridge.setScreenSpace(356);
  await bridge.configure(true);event(expanded);await bridge.ready();
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("224px");
  expect(bridge.setScreenSpace(356)).toBe(0);
  for(const scale of [1,1.25,1.5,2]){
    // A negative monitor origin must not affect the work-area-relative budget.
    const screenTop=-900,anchorY=screenTop+Math.round(356*scale);
    const native=send.mock.calls.at(-1)![0]!;
    const origin=anchorY+Math.round(native.top*scale);
    expect(origin).toBe(screenTop);
    expect(bridge.hostPosition({x:0,y:origin},scale).y).toBe(anchorY/scale);
  }
  expect(send.mock.calls.at(-1)![0]!.top).toBe(-356);
  const calls=send.mock.calls.length;bridge.setScreenSpace(356);expect(send).toHaveBeenCalledTimes(calls);
  await bridge.destroy();
});

it("requests only the missing screen clearance when a minimum question or fees cannot fit",async()=>{
  bubble.dataset.interactive="true";
  vi.spyOn(bubble,"getBoundingClientRect").mockImplementation(()=>({height:Math.min(700,Number.parseFloat(anchor.style.getPropertyValue("--bubble-max-height"))||700)}) as DOMRect);
  const send=vi.fn(async(_value:ModelViewport|null)=>{});
  const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  bridge.setScreenSpace(160);await bridge.configure(true);event(expanded);await bridge.ready();
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("128px");
  expect(bridge.setScreenSpace(160)).toBe(100);
  // After the caller moves the anchor by exactly this correction, a repeated
  // position read must not cause another move or expand the form indefinitely.
  const calls=send.mock.calls.length;
  expect(bridge.setScreenSpace(260)).toBe(0);expect(send).toHaveBeenCalledTimes(calls);
  bubble.dataset.interactive="false";
  vi.mocked(bubble.getBoundingClientRect).mockReturnValue({height:120} as DOMRect);
  await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("432px"));
  expect(bridge.setScreenSpace(228)).toBe(24);
  expect(bridge.setScreenSpace(252)).toBe(0);
  bubble.hidden=true;await Promise.resolve();expect(bridge.setScreenSpace(0)).toBe(0);
  await bridge.destroy();
});
