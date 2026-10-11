// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ModelViewportBridge,type ModelViewport} from "../src/model-viewport.js";

const expanded:ModelViewport={left:-64,top:-96,width:448,height:608,baseWidth:320,baseHeight:480};
let host:HTMLElement,anchor:HTMLElement,surface:HTMLElement,bubble:HTMLElement;
let resized:()=>void,height:number;
beforeEach(()=>{
  document.body.innerHTML='<main id="pet-view"><div id="model"><div id="surface"></div></div><output id="bubble"></output></main>';
  host=document.getElementById("model")!;anchor=document.getElementById("pet-view")!;surface=document.getElementById("surface")!;
  bubble=document.getElementById("bubble")!;height=62;
  vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});
  vi.spyOn(bubble,"getBoundingClientRect").mockImplementation(()=>({height:bubble.hidden?0:Math.min(height,Number.parseFloat(anchor.style.getPropertyValue("--bubble-max-height"))||height)}) as DOMRect);
});
afterEach(()=>vi.unstubAllGlobals());
const event=(value:unknown)=>surface.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true,detail:value}));

it("reserves fixed gesture and bubble bounds before mounting without changing portrait scale",async()=>{
  const send=vi.fn(async()=>{}),applied=vi.fn(),invalidate=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,applied,vi.fn(),bubble);
  await bridge.configure(true);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({left:-128,top:-532,width:576,height:1204,baseWidth:320,baseHeight:480});
  expect(anchor.style.getPropertyValue("--model-width")).toBe("320px");
  expect(anchor.style.getPropertyValue("--model-height")).toBe("480px");
  expect(anchor.style.getPropertyValue("--model-left")).toBe("128px");
  expect(anchor.style.getPropertyValue("--model-top")).toBe("532px");
  expect(anchor.style.getPropertyValue("--bubble-left")).toBe("288px");
  expect(anchor.style.getPropertyValue("--bubble-width")).toBe("288px");
  expect(invalidate).toHaveBeenCalledOnce();expect(applied).toHaveBeenCalledOnce();
  for(const scale of [1,1.25,1.5,2]) {
    const origin={x:300+Math.round(-128*scale),y:400+Math.round(-532*scale)};
    expect(bridge.hostPosition(origin,scale)).toEqual({x:300/scale,y:400/scale});
  }
});

it("never resizes, moves the anchor or clears hit coverage when actions or bubble contents change",async()=>{
  const send=vi.fn(async()=>{}),invalidate=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);
  const point=bridge.hostPosition({x:300,y:-100},1.25);
  for(const nextHeight of [62,220,432,700,62]) {
    height=nextHeight;resized();event(expanded);event({...expanded,left:-128,width:576});await bridge.ready();
    expect(bridge.hostPosition({x:300,y:-100},1.25)).toEqual(point);
    const modelTop=Number.parseFloat(anchor.style.getPropertyValue("--model-top"));
    const bubbleTop=Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"));
    expect(modelTop-(bubbleTop+Math.min(height,432))).toBe(24);
    expect(bubbleTop).toBeGreaterThanOrEqual(12);
  }
  bubble.hidden=true;await Promise.resolve();bubble.hidden=false;await Promise.resolve();
  expect(send).toHaveBeenCalledOnce();expect(invalidate).toHaveBeenCalledOnce();
});

it("waits for the one native resize and ignores renderer events while it is pending",async()=>{
  let finish!:()=>void;const applied=vi.fn();
  const send=vi.fn(()=>new Promise<void>(done=>{finish=done;}));
  const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),applied,vi.fn(),bubble);
  const pending=bridge.configure(true);event(expanded);height=432;resized();
  expect(bridge.pending).toBe(true);expect(send).toHaveBeenCalledOnce();expect(applied).not.toHaveBeenCalled();
  finish();await pending;expect(bridge.pending).toBe(false);expect(applied).toHaveBeenCalledOnce();
});

it("does not resize for same-backend remounts and restores geometry only when leaving VRM",async()=>{
  const send=vi.fn(async()=>{});const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(false);event(expanded);expect(send).not.toHaveBeenCalled();
  await bridge.configure(true);await bridge.configure(true);event(expanded);expect(send).toHaveBeenCalledOnce();
  await bridge.configure(false);expect(send).toHaveBeenLastCalledWith(null);expect(send).toHaveBeenCalledTimes(2);
  expect(anchor.classList.contains("vrm-viewport")).toBe(false);expect(anchor.style.getPropertyValue("--bubble-width")).toBe("");
  await bridge.configure(true);await bridge.destroy();await bridge.destroy();
  expect(send).toHaveBeenCalledTimes(4);expect(send).toHaveBeenLastCalledWith(null);
});

it("contains a native failure without repeated automatic geometry attempts",async()=>{
  const failed=vi.fn(),send=vi.fn(async()=>{throw new Error("native unavailable")});
  const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),failed,bubble);
  await expect(bridge.configure(true)).rejects.toThrow("native unavailable");
  event(expanded);height=220;resized();
  expect(send).toHaveBeenCalledOnce();expect(failed).toHaveBeenCalledOnce();expect(bridge.pending).toBe(false);
});

it("budgets and scrolls a tall bubble at screen boundaries without requesting any model movement",async()=>{
  height=700;bubble.dataset.interactive="true";
  const send=vi.fn(async()=>{}),layout=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble,layout);
  bridge.setScreenSpace(356);await bridge.configure(true);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("320px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("188px");
  const anchorTop=anchor.style.getPropertyValue("--model-top");
  // Even the minimum form cannot fit above a manually dragged top-edge model:
  // keep its controls on screen by repositioning the bubble alone.
  bridge.setScreenSpace(100);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("128px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("444px");
  expect(anchor.style.getPropertyValue("--model-top")).toBe(anchorTop);
  expect(send).toHaveBeenCalledOnce();expect(layout).toHaveBeenCalledTimes(2);
  bridge.setScreenSpace(100);expect(layout).toHaveBeenCalledTimes(2);
  bridge.setScreenSpace(1000);expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("432px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("76px");expect(send).toHaveBeenCalledOnce();
});

it("bottom-aligns a balance card after hidden content and a previously clipped question",async()=>{
  bubble.hidden=true;height=700;
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  bridge.setScreenSpace(100);await bridge.configure(true);
  bubble.hidden=false;resized();
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("444px");
  // ResizeObserver sees the restored natural height after the screen budget
  // grows, then sees the shorter replacement card rather than the old form.
  bridge.setScreenSpace(1000);
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("76px");
  height=220;resized();
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("288px");
  expect(Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"))+height).toBe(508);
  expect(send).toHaveBeenCalledOnce();
});

it("leaves Inochi2D geometry and bubble layout unchanged",async()=>{
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(false);height=160;resized();bridge.setScreenSpace(100);await bridge.ready();
  expect(send).not.toHaveBeenCalled();expect(anchor.style.getPropertyValue("--model-top")).toBe("");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("");await bridge.destroy();
});
