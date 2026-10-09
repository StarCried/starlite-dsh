// @vitest-environment happy-dom
import {beforeEach,expect,it,vi} from "vitest";
import {ModelViewportBridge,type ModelViewport} from "../src/model-viewport.js";

const expanded:ModelViewport={left:-64,top:-96,width:448,height:608,baseWidth:320,baseHeight:480};
let host:HTMLElement,anchor:HTMLElement,surface:HTMLElement;
beforeEach(()=>{
  document.body.innerHTML='<main id="pet-view"><div id="model"><div id="surface"></div></div><output id="bubble"></output></main>';
  host=document.getElementById("model")!;anchor=document.getElementById("pet-view")!;surface=document.getElementById("surface")!;
});
const event=(value:unknown)=>surface.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true,detail:value}));

it("receives the first mount event and keeps model size, bubble width and screen anchor stable",async()=>{
  const send=vi.fn(async()=>{}),applied=vi.fn(),invalidate=vi.fn();
  const bridge=new ModelViewportBridge(host,anchor,send,invalidate,applied,vi.fn());
  await bridge.configure(true);
  event(expanded);await bridge.ready();
  expect(send).toHaveBeenLastCalledWith(expanded);
  expect(anchor.style.getPropertyValue("--model-width")).toBe("320px");
  expect(anchor.style.getPropertyValue("--model-height")).toBe("480px");
  expect(anchor.style.getPropertyValue("--model-left")).toBe("64px");
  expect(anchor.style.getPropertyValue("--model-top")).toBe("96px");
  expect(anchor.style.getPropertyValue("--bubble-left")).toBe("224px");
  expect(anchor.style.getPropertyValue("--bubble-top")).toBe("106px");
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
  const bridge=new ModelViewportBridge(host,anchor,()=>new Promise<void>(done=>finish.push(done)),vi.fn(),applied,vi.fn());
  const initial=bridge.configure(true);event(expanded);
  expect(bridge.pending).toBe(true);expect(finish).toHaveLength(2);
  finish[0]!();await initial;expect(bridge.pending).toBe(true);expect(applied).not.toHaveBeenCalled();
  finish[1]!();await bridge.ready();expect(bridge.pending).toBe(false);expect(applied).toHaveBeenCalledOnce();
});

it("restores geometry on remount and teardown and leaves Inochi2D unchanged",async()=>{
  const send=vi.fn(async()=>{});const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),vi.fn());
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
  const send=vi.fn(async()=>{}),failed=vi.fn();const bridge=new ModelViewportBridge(host,anchor,send,vi.fn(),vi.fn(),failed);
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
