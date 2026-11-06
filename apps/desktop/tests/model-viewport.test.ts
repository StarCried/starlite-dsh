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

it("changes the real display area only for an explicit size change and keeps text size independent",async()=>{
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);await bridge.configure(true,.5);await bridge.configure(true,.5);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith({left:-128,top:-532,width:416,height:964,baseWidth:160,baseHeight:240});
  expect(bridge.modelRect).toEqual({left:128,top:532,width:160,height:240});
  expect(anchor.style.getPropertyValue("--bubble-width")).toBe("288px");
  expect(bridge.hostPosition({x:0,y:0},1)).toEqual({x:128,y:532});
  await expect(bridge.configure(true,Infinity)).rejects.toThrow("invalid model size");
  expect(send).toHaveBeenCalledTimes(2);await bridge.destroy();
});

it("reserves the fixed visitor toolbar after a large portrait is shrunk without moving its native origin",async()=>{
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true,1.5);
  const portrait=bridge.modelRect,toolbar={left:portrait.left+portrait.width/2-76,top:portrait.top+portrait.height+10,width:152,height:42};
  const origin=bridge.hostPosition({x:400,y:200},1.5);
  await bridge.reserveToolbarSpace(toolbar);expect(send).toHaveBeenCalledOnce();
  await bridge.configure(true,.5);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({width:456,height:1316,baseWidth:160,baseHeight:240}));
  expect(bridge.hostPosition({x:400,y:200},1.5)).toEqual(origin);
  await bridge.destroy();
});

it("reserves a stable menu surface before opening and does not shrink it during a slider drag",async()=>{
  const send=vi.fn<(value:ModelViewport|null)=>Promise<void>>(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true,.67);
  const origin=bridge.hostPosition({x:200,y:-120},1.5);
  await bridge.reserveMenuSpace(true);
  for(const scale of [1.5,1.25,.8,.5,.75,1.35]){
    await bridge.configure(true,scale);
    const value=send.mock.calls.at(-1)![0] as ModelViewport;
    expect(value.width).toBe(736);expect(value.height).toBe(1444);
    expect(value.baseWidth).toBe(Math.round(320*scale));expect(value.baseHeight).toBe(Math.round(480*scale));
    expect(bridge.hostPosition({x:200,y:-120},1.5)).toEqual(origin);
  }
  const count=send.mock.calls.length;
  await bridge.reserveMenuSpace(true);expect(send).toHaveBeenCalledTimes(count);
  await bridge.reserveMenuSpace(false);
  expect(send).toHaveBeenLastCalledWith({left:-128,top:-532,width:688,height:1372,baseWidth:432,baseHeight:648});
  await bridge.destroy();
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
  height=220;bubble.dataset.bubbleKind="billing";resized();
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("328px");
  expect(Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"))+height).toBe(548);
  expect(send).toHaveBeenCalledOnce();
});

it("repositions an equal-height balance overlay and restores work layout on kind changes alone",async()=>{
  height=220;bubble.dataset.bubbleKind="notice";bubble.dataset.interactive="true";
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("288px");
  // Both kinds are interactive and equally tall: no resize or visibility event
  // accompanies a work/form-to-balance switch.
  bubble.dataset.bubbleKind="billing";
  await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-top")).toBe("328px"));
  bubble.dataset.bubbleKind="notice";
  await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-top")).toBe("288px"));
  expect(send).toHaveBeenCalledOnce();await bridge.destroy();
});

it("budgets the balance inset within the screen edge and preserves the question budget",async()=>{
  height=700;bubble.dataset.bubbleKind="billing";
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  bridge.setScreenSpace(356);await bridge.configure(true);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("360px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("188px");
  // On-screen top stays at 12px; the extra budget extends the card down toward
  // the head rather than pushing its top out of the work area.
  const modelTop=Number.parseFloat(anchor.style.getPropertyValue("--model-top"));
  expect(356-modelTop+Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"))).toBe(12);
  bubble.dataset.bubbleKind="notice";
  await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("320px"));
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("188px");
  bubble.dataset.bubbleKind="billing";bridge.setScreenSpace(100);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("128px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("444px");
  expect(anchor.style.getPropertyValue("--model-top")).toBe(`${modelTop}px`);
  expect(send).toHaveBeenCalledOnce();await bridge.destroy();
});

it("leaves Inochi2D geometry and bubble layout unchanged",async()=>{
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(false);height=160;resized();bridge.setScreenSpace(100);await bridge.ready();
  expect(send).not.toHaveBeenCalled();expect(anchor.style.getPropertyValue("--model-top")).toBe("");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("");await bridge.destroy();
});

it("attaches every bubble kind to the model's stable visible top without moving its surface",async()=>{
  height=220;
  const send=vi.fn(async()=>{}),invalidate=vi.fn(),layout=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,vi.fn(),vi.fn(),bubble,layout);
  await bridge.configure(true);
  const fixed=bridge.modelRect;
  for(const top of [20,140]){
    bridge.setBubbleAnchor({x:150,y:top});
    for(const kind of ["notice","billing","work","question"]){
      bubble.dataset.bubbleKind=kind;resized();event(expanded);
      expect(Number.parseFloat(anchor.style.getPropertyValue("--bubble-top"))+height+24).toBe(fixed.top+top);
      expect(anchor.style.getPropertyValue("--bubble-left")).toBe("278px");
      expect(bridge.modelRect).toEqual(fixed);
    }
  }
  const changes=layout.mock.calls.length;
  bridge.setBubbleAnchor({x:150,y:140});
  expect(layout).toHaveBeenCalledTimes(changes);
  expect(send).toHaveBeenCalledOnce();expect(invalidate).toHaveBeenCalledOnce();
});

it("budgets the visible head offset at screen edges and does not apply DPR twice",async()=>{
  height=700;
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);
  bridge.setBubbleAnchor({x:160,y:100});bridge.setScreenSpace(356);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("420px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("188px");
  for(const dpi of [1,1.25,1.5,2]){
    const point=bridge.hostPosition({x:Math.round((300-128)*dpi),y:Math.round((356-532)*dpi)},dpi);
    bridge.setScreenSpace(point.y);
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("188px");
    expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("420px");
  }
  bridge.setScreenSpace(0);
  expect(anchor.style.getPropertyValue("--bubble-max-height")).toBe("128px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("544px");
  expect(send).toHaveBeenCalledOnce();
});

it("accepts resized anchors and forgets them on model replacement without extra native geometry",async()=>{
  height=62;bubble.dataset.bubbleKind="billing";
  const send=vi.fn(async()=>{}),bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn(),bubble);
  await bridge.configure(true);bridge.setBubbleAnchor({x:160,y:100});
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("546px");
  await bridge.configure(true,.5);bridge.setBubbleAnchor({x:80,y:50});
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("496px");
  expect(anchor.style.getPropertyValue("--bubble-left")).toBe("208px");
  for(const value of [undefined,{x:NaN,y:100},{x:160,y:Infinity}]){
    bridge.setBubbleAnchor(value);
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("486px");
  }
  expect(send).toHaveBeenCalledTimes(2);
});
