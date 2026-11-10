// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, ModelAdjustments } from "../src/types.js";
import type { WidgetController, VisitorToolbar, VisitorToolbarOptions } from "../src/vendor-types.js";
import type {PetUiState} from "../src/quick-settings.js";
import { startPet } from "../src/pet.js";
import {CONTROL_LEASE_MS,type ControlFrame} from "@starcried/starlite-dsh-protocol";

const native = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), getCurrent: vi.fn(), onOpenUrl: vi.fn(),
  getCurrentWindow: vi.fn(), availableMonitors: vi.fn(), primaryMonitor: vi.fn(),
  createModelSlot: vi.fn(), createQuickMenu:vi.fn(), createVisitorToolbar:vi.fn(), loadModelDragGesture:vi.fn(), mountModel: vi.fn(), connection: vi.fn(), message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({invoke: native.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen: native.listen}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: native.getCurrentWindow, availableMonitors: native.availableMonitors,
  primaryMonitor: native.primaryMonitor, PhysicalPosition: class {constructor(readonly x: number, readonly y: number) {}},
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({getCurrent: native.getCurrent, onOpenUrl: native.onOpenUrl}));
vi.mock("@tauri-apps/plugin-dialog", () => ({message:native.message}));
vi.mock("../src/renderer.js", () => ({createModelSlot: native.createModelSlot,createQuickMenu:native.createQuickMenu, createVisitorToolbar:native.createVisitorToolbar, loadModelDragGesture:native.loadModelDragGesture, mountModel: native.mountModel}));
vi.mock("../src/connection.js", () => ({StatusConnection: class {
  constructor(callbacks: unknown) { return native.connection(callbacks); }
}}));

interface ConnectionCallbacks {onConnected(): void; onDisconnected(): void; onSnapshot(value: unknown): void; onConflict(): void;onControl(value:ControlFrame):void}
const settings: DesktopSettings = {
  schemaVersion: 4,
  preferences: {fps: 30, maxDevicePixelRatio: 1.5, scale: .67, privacyMode: false, bubbleMode: "compact", performanceOverlay: false},
  activeModelId: "fixture",
  models: [{id: "fixture", title: "Fixture", backend: "vrm", modelPath: "C:\\fixture\\model.vrm", sourceSha256: "a".repeat(64),
    animations: [{name: "Idle", durationMs: 1_000}],
    mappings: {idle: "Idle", working: null, completed: null, error: null, blocked: null, approval: null, click: [], ambient: []},
    vrm: {animations: []}}],
};
let visibility: DocumentVisibilityState;
let controller: WidgetController;
let show: ReturnType<typeof vi.fn>;
let finishDeepLinks: (() => void) | undefined;
let finishTraySubscription: (() => void) | undefined;
let trayListener: ((event: {payload: string}) => void) | undefined;
let settingsListener: ((event: {payload: DesktopSettings}) => void) | undefined;
let adjustmentListener: ((event: {payload: {modelId: string; adjustments: ModelAdjustments}}) => void) | undefined;
let uiListener: ((event:{payload:PetUiState})=>void)|undefined;
let deepLinkListener: ((urls:string[])=>void) | undefined;
let cursorListener: ((event:{payload:{x:number;y:number}})=>void)|undefined;
const INITIAL_URL = `dsh-inochi2d-pet://connect?port=41234&token=${"a".repeat(43)}&instance=12345678-1234-4234-8234-123456789abc`;

function changeVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  document.body.innerHTML = '<main id="pet-view"><output id="bubble" hidden></output><div id="model"></div><button id="empty-model"></button></main>';
  let running = false;
  controller = {
    get status() { return running ? "running" : "paused"; },
    pause: vi.fn(() => {running = false;}), resume: vi.fn(() => {running = true;}),
    getAnimations: () => [{name: "Idle", durationMs: 1_000}],
    playAnimation: vi.fn(async () => "stopped" as const), stopAnimation: vi.fn(), resetCamera: vi.fn(),
    observeInteractionMask: vi.fn(), setPointerPosition: vi.fn(), setPerformanceVisible: vi.fn(),setFrameRate:vi.fn(),setDisplaySize:vi.fn(),setPointerEnabled:vi.fn(),setModelAdjustments:vi.fn(),refreshInteractionMask:vi.fn(), destroy: vi.fn(),
    setHostPosition:vi.fn(),
  };
  const monitor = {position: {x: 0, y: 0}, size: {width: 1920, height: 1080}, workArea: {position: {x: 0, y: 0}}};
  native.availableMonitors.mockResolvedValue([monitor]); native.primaryMonitor.mockResolvedValue(monitor);
  show = vi.fn(async () => changeVisibility("visible"));
  native.getCurrentWindow.mockReturnValue({
    show, hide: vi.fn(async () => changeVisibility("hidden")),
    onMoved: vi.fn(async () => () => undefined), outerPosition: vi.fn(async () => ({x: 400, y: 400})),
    outerSize: vi.fn(async () => ({width: 320, height: 480})), setPosition: vi.fn(async () => undefined),
  });
  native.invoke.mockImplementation(async command => command === "get_settings" || command === "prepare_model" ? structuredClone(settings) : command === "get_initial_connection" ? INITIAL_URL : command === "get_pet_ui_state" ? {paused:false,visible:true,clickThrough:false}:undefined);
  native.createVisitorToolbar.mockResolvedValue({element:document.createElement("aside"),dimensions:{width:152,height:42},update:vi.fn(),show:vi.fn(),place:vi.fn(),reattach:vi.fn(),destroy:vi.fn()});
  native.loadModelDragGesture.mockResolvedValue((dx:number,dy:number)=>Number.isFinite(dx)&&Number.isFinite(dy)&&Math.hypot(dx,dy)>6);
  native.createQuickMenu.mockResolvedValue({element:document.createElement("aside"),isOpen:false,open:vi.fn(),close:vi.fn(),update:vi.fn(),destroy:vi.fn()});
  native.listen.mockImplementation(async (event, listener) => {
    if (event === "tray-action") {
      trayListener = listener;
      await new Promise<void>(resolve => {finishTraySubscription = resolve;});
    }
    if (event === "settings-changed") settingsListener = listener;
    if (event === "model-adjustments-preview") adjustmentListener = listener;
    if (event === "pet-ui-state") uiListener = listener;
    if (event === "pet-cursor") cursorListener = listener;
    return () => undefined;
  });
  native.getCurrent.mockResolvedValue([INITIAL_URL]);
  native.onOpenUrl.mockImplementation(listener => {deepLinkListener=listener;return new Promise<() => void>(resolve => {finishDeepLinks = () => resolve(() => undefined);});});
  native.message.mockResolvedValue(undefined);
  native.createModelSlot.mockResolvedValue({
    mount: (factory: (signal: AbortSignal) => Promise<WidgetController>) => factory(new AbortController().signal),
    destroy: vi.fn(() => controller.destroy()),
  });
  native.mountModel.mockResolvedValue(controller);
  native.connection.mockImplementation((callbacks: ConnectionCallbacks) => {
    let first: string | undefined;
    return {
    connect: vi.fn((url: string) => {if (first) return url === first ? "unchanged" : "conflict"; first = url; queueMicrotask(() => {
      callbacks.onConnected();
      callbacks.onSnapshot({protocolVersion: 1, sequence: 1, emittedAt: 1, state: "idle"});
    });return "accepted";}),
    connectPending: vi.fn(() => false), stop: vi.fn(), setInputAvailable: vi.fn(async () => undefined),
    reportControl:vi.fn(async()=>undefined),acknowledgeControl:vi.fn(async()=>undefined),releaseControl:vi.fn(async()=>undefined),
  };});
});

afterEach(async () => {
  finishDeepLinks?.(); finishTraySubscription?.();
  globalThis.dispatchEvent(new Event("pagehide"));
  await Promise.resolve(); await Promise.resolve();
  finishDeepLinks = undefined; finishTraySubscription = undefined; trayListener = undefined; settingsListener = undefined;deepLinkListener=undefined;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks();
});

describe("desktop hidden-window startup", () => {
  it("authorizes a drag on the enlarged silhouette before restoring session scale",async()=>{
    vi.stubGlobal("innerWidth",736);vi.stubGlobal("innerHeight",1444);
    try{
      let publishMask:Parameters<WidgetController["observeInteractionMask"]>[0];
      vi.mocked(controller.observeInteractionMask).mockImplementation(listener=>{publishMask=listener;});
      const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
      await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
      const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks,bridge=native.connection.mock.results[0]!.value;
      const next=structuredClone(settings);next.preferences.sessionControlEnabled=true;settingsListener!({payload:next});
      await vi.waitFor(()=>expect(bridge.reportControl).toHaveBeenLastCalledWith(expect.objectContaining({enabled:true})));
      const leaseId="123e4567-e89b-42d3-a456-426614174000";
      const envelope=(sequence:number)=>({controlVersion:1 as const,sequence,leaseId,commandId:`123e4567-e89b-42d3-a456-${String(sequence).padStart(12,"0")}`,leaseMs:CONTROL_LEASE_MS});
      callbacks.onControl({...envelope(1),kind:"acquire",sessionTitle:"Drag test"});
      await vi.waitFor(()=>expect(bridge.acknowledgeControl).toHaveBeenCalledWith(expect.objectContaining({commandId:envelope(1).commandId,status:"completed"})));
      callbacks.onControl({...envelope(2),kind:"stage",scale:1.5});
      await vi.waitFor(()=>expect(controller.setDisplaySize).toHaveBeenLastCalledWith(480,720));
      publishMask!({width:1,height:1,left:300,top:550,displayWidth:100,displayHeight:100,viewportWidth:736,viewportHeight:1444,bits:new Uint8Array([1])});
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_model_hit_mask",expect.objectContaining({mask:expect.objectContaining({top:550})})));
      const host=document.getElementById("model")!;
      host.setPointerCapture=vi.fn();host.hasPointerCapture=()=>true;host.releasePointerCapture=vi.fn();
      const original=native.invoke.getMockImplementation()!;
      native.invoke.mockImplementation(async(command,...args)=>{
        if(command==="begin_model_drag"){
          // This head point lies above the baseline model's head. Restoring
          // before native authorization would fail the real alpha hit test.
          const size=vi.mocked(controller.setDisplaySize!).mock.calls.at(-1);
          if(size?.[0]!==480)throw Error("pointer is outside the restored model");
        }
        return original(command,...args);
      });
      const event=(name:string,x:number)=>new PointerEvent(name,{button:0,pointerId:1,clientX:x,clientY:575,screenX:x,screenY:575});
      host.dispatchEvent(event("pointerdown",350));host.dispatchEvent(event("pointermove",365));
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("move_model_drag"));
      expect(controller.setDisplaySize).toHaveBeenLastCalledWith(320*.67,480*.67);
      expect(native.invoke).toHaveBeenCalledWith("end_session_stage",expect.objectContaining({restore:false}));
      expect(bridge.releaseControl).toHaveBeenCalledWith({leaseId,reason:"user"});
      const start=native.invoke.mock.calls.findIndex(([command])=>command==="begin_model_drag");
      expect(native.invoke.mock.calls.slice(start).some(([command,args])=>command==="set_model_hit_mask"&&args?.mask===null)).toBe(false);
      host.dispatchEvent(event("pointerup",380));await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("end_model_drag"));
      expect(native.invoke.mock.calls.filter(([command])=>command==="move_model_drag").length).toBeGreaterThanOrEqual(2);
    }finally{vi.unstubAllGlobals();}
  });
  it("suspends automatic presentation during takeover and restores the latest state without persisting temporary geometry",async()=>{
    const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks,bridge=native.connection.mock.results[0]!.value;
    const next=structuredClone(settings);next.preferences.sessionControlEnabled=true;next.preferences.bubbleMode="detailed";
    next.models[0]!.mappings.working="Work";next.models[0]!.animations.push({name:"Wave",durationMs:1200},{name:"Work",durationMs:900});
    controller.getAnimations=()=>next.models[0]!.animations;
    vi.mocked(controller.playAnimation).mockImplementation(()=>new Promise(()=>{}));
    settingsListener!({payload:next});
    await vi.waitFor(()=>expect(bridge.reportControl).toHaveBeenLastCalledWith(expect.objectContaining({enabled:true,available:true})));
    const leaseId="123e4567-e89b-42d3-a456-426614174000";
    const envelope=(sequence:number)=>({controlVersion:1 as const,sequence,leaseId,commandId:`123e4567-e89b-42d3-a456-${String(sequence).padStart(12,"0")}`,leaseMs:CONTROL_LEASE_MS});
    callbacks.onControl({...envelope(1),kind:"acquire",sessionTitle:"Character chat"});
    await vi.waitFor(()=>expect(bridge.acknowledgeControl).toHaveBeenCalledWith(expect.objectContaining({commandId:envelope(1).commandId,status:"completed"})));
    const toolbar=await native.createVisitorToolbar.mock.results[0]!.value as VisitorToolbar;
    const toolbarOptions=native.createVisitorToolbar.mock.calls[0]![0] as VisitorToolbarOptions;
    expect(toolbar.update).toHaveBeenLastCalledWith(expect.objectContaining({controlActive:true}));
    expect(toolbar.show).toHaveBeenLastCalledWith(false);
    expect(document.querySelector(".session-control-badge")).toBeNull();
    expect(document.body.textContent).not.toContain("Character chat");
    cursorListener!({payload:{x:300,y:1000}});expect(toolbar.show).toHaveBeenLastCalledWith(true);
    cursorListener!({payload:{x:-100,y:-100}});await vi.advanceTimersByTimeAsync(650);expect(toolbar.show).toHaveBeenLastCalledWith(false);
    expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(false);
    callbacks.onControl({...envelope(2),kind:"perform",animation:"Wave",text:"My own bubble",durationMs:5000});
    expect(document.getElementById("bubble")!.textContent).toContain("My own bubble");
    expect(document.querySelector("#bubble .bubble-title")).toBeNull();
    expect(document.getElementById("bubble")!.textContent).not.toContain("Character chat");
    callbacks.onSnapshot({protocolVersion:1,sequence:10,emittedAt:1,state:"working",session:{ref:leaseId,title:"Latest session"},bubble:{kind:"response",text:"Latest work"}});
    expect(controller.playAnimation).not.toHaveBeenCalledWith("Work",expect.anything());
    expect(document.getElementById("bubble")!.textContent).not.toContain("Latest work");
    callbacks.onControl({...envelope(3),kind:"stage",scale:.8,pointerEnabled:false,position:{x:.2,y:.6}});
    await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_session_stage_position",expect.objectContaining({x:.2,y:.6})));
    expect(controller.setDisplaySize).toHaveBeenLastCalledWith(256,384);expect(controller.setPointerEnabled).toHaveBeenLastCalledWith(false);
    expect(native.invoke.mock.calls.some(([command])=>command==="patch_preferences")).toBe(false);
    await toolbarOptions.onReleaseControl!();
    await vi.waitFor(()=>expect(controller.playAnimation).toHaveBeenCalledWith("Work",{mode:"once",restart:true}));
    expect(document.getElementById("bubble")!.textContent).toContain("Latest work");
    expect(controller.setDisplaySize).toHaveBeenLastCalledWith(320*.67,480*.67);expect(controller.setPointerEnabled).toHaveBeenLastCalledWith(true);
    expect(native.invoke).toHaveBeenCalledWith("end_session_stage",expect.objectContaining({restore:true}));
    expect(bridge.releaseControl).toHaveBeenCalledWith({leaseId,reason:"user"});
    expect(toolbar.update).toHaveBeenLastCalledWith(expect.objectContaining({controlActive:false}));
    await vi.waitFor(()=>expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(true));
  });
  it("shares visible toolbar coverage, persisted controls and paused hot resizing without remounting",async()=>{
    vi.stubGlobal("innerWidth",736);vi.stubGlobal("innerHeight",1444);
    try{
      const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
      await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
      const toolbar=await native.createVisitorToolbar.mock.results[0]!.value as VisitorToolbar;
      const options=native.createVisitorToolbar.mock.calls[0]![0] as VisitorToolbarOptions;
      const region={left:292,top:1262,width:152,height:42,viewportWidth:736,viewportHeight:1444};
      expect(toolbar.show).toHaveBeenLastCalledWith(false);
      cursorListener!({payload:{x:300,y:1000}});
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_menu_interaction_region",{region}));
      uiListener!({payload:{paused:true,visible:true,clickThrough:false}});
      await options.onLarger();expect(native.invoke).toHaveBeenCalledWith("patch_preferences",{patch:{scale:.77}});
      const next=structuredClone(settings);next.preferences.scale=.77;settingsListener!({payload:next});
      await vi.waitFor(()=>expect(controller.setDisplaySize).toHaveBeenCalledWith(246.4,369.6));
      await vi.waitFor(()=>expect(controller.setHostPosition).toHaveBeenLastCalledWith(expect.any(Number),expect.any(Number),{resetMotion:true}));
      globalThis.dispatchEvent(new Event("resize"));
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_menu_interaction_region",{region}));
      expect(toolbar.place).toHaveBeenLastCalledWith(368,1262,1000);
      expect(controller.status).toBe("paused");expect(native.mountModel).toHaveBeenCalledOnce();
      await options.onBubbles();expect(native.invoke).toHaveBeenCalledWith("patch_preferences",{patch:{bubblesVisible:false}});
      globalThis.dispatchEvent(new Event("blur"));
      await vi.waitFor(()=>expect(native.invoke.mock.calls.filter(([command])=>command==="set_menu_interaction_region").at(-1)).toEqual(["set_menu_interaction_region",{region:null}]));
      cursorListener!({payload:{x:300,y:1000}});expect(toolbar.show).toHaveBeenLastCalledWith(false);
      cursorListener!({payload:{x:301,y:1000}});expect(toolbar.show).toHaveBeenLastCalledWith(true);
      await options.onHide();expect(native.invoke).toHaveBeenCalledWith("set_pet_visible",{visible:false});
      expect(toolbar.show).toHaveBeenLastCalledWith(false);
    }finally{vi.unstubAllGlobals();}
  });
  it("preserves the open menu screen anchor when an external size expands the reserved range",async()=>{
    vi.stubGlobal("innerWidth",1216);vi.stubGlobal("innerHeight",2164);
    try{
      const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
      await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
      const menu=await native.createQuickMenu.mock.results[0]!.value;
      menu.isOpen=true;menu.element.style.left="100px";menu.element.style.top="200px";
      vi.spyOn(menu.element,"getBoundingClientRect").mockImplementation(()=>{
        const left=parseFloat(menu.element.style.left),top=parseFloat(menu.element.style.top);
        return {left,top,right:left+200,bottom:top+100,width:200,height:100} as DOMRect;
      });
      menu.element.dispatchEvent(new CustomEvent("starlite-menu-change"));
      let position={x:400,y:400};
      native.getCurrentWindow.mock.results[0]!.value.outerPosition.mockImplementation(async()=>position);
      const invoke=native.invoke.getMockImplementation()!;
      native.invoke.mockImplementation(async(command,args)=>{
        if(command==="set_model_viewport"&&args.viewport?.baseWidth===960)position={x:160,y:-320};
        return invoke(command,args);
      });
      const next=structuredClone(settings);next.preferences.scale=3;settingsListener!({payload:next});
      await vi.waitFor(()=>expect(controller.setDisplaySize).toHaveBeenCalledWith(960,1440));
      expect(menu.element.style.left).toBe("340px");expect(menu.element.style.top).toBe("920px");
      expect(340+position.x).toBe(500);expect(920+position.y).toBe(600);
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_menu_interaction_region",{region:{left:340,top:920,width:200,height:100,viewportWidth:1216,viewportHeight:2164}}));
      expect(native.mountModel).toHaveBeenCalledOnce();
    }finally{vi.unstubAllGlobals();}
  });
  it("hides work and question bubbles without remounting or intercepting DSH input",async()=>{
    const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks,bridge=native.connection.mock.results[0]!.value;
    const next=structuredClone(settings);next.preferences.bubblesVisible=false;settingsListener!({payload:next});
    callbacks.onSnapshot({protocolVersion:1,sequence:3,emittedAt:1,state:"working",bubble:{kind:"response",text:"hidden"}});
    await vi.waitFor(()=>expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(false));
    expect(document.querySelector<HTMLOutputElement>("#bubble")!.hidden).toBe(true);
    expect(native.mountModel).toHaveBeenCalledOnce();
    next.preferences.bubblesVisible=true;settingsListener!({payload:next});
    await vi.waitFor(()=>expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(true));
    expect(document.querySelector<HTMLOutputElement>("#bubble")!.hidden).toBe(false);
  });
  it("hot-updates size while paused and explicitly refreshes the native interaction mask",async()=>{
    const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    uiListener!({payload:{paused:true,visible:true,clickThrough:false}});
    const next=structuredClone(settings);next.preferences.scale=.8;next.preferences.fps=60;next.preferences.pointerEnabled=false;
    settingsListener!({payload:next});
    await vi.waitFor(()=>expect(controller.setDisplaySize).toHaveBeenCalledWith(256,384));
    expect(controller.refreshInteractionMask).toHaveBeenCalled();expect(controller.setFrameRate).toHaveBeenLastCalledWith(60);expect(controller.setPointerEnabled).toHaveBeenLastCalledWith(false);
    expect(controller.status).toBe("paused");expect(native.mountModel).toHaveBeenCalledOnce();
  });
  it("keeps an explicitly hidden pet hidden on Host reconnect and releases input during click-through",async()=>{
    const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks,bridge=native.connection.mock.results[0]!.value;
    show.mockClear();uiListener!({payload:{paused:false,visible:false,clickThrough:false}});callbacks.onConnected();
    await vi.waitFor(()=>expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(false));
    expect(show).not.toHaveBeenCalled();expect(native.invoke).not.toHaveBeenCalledWith("open_settings");
    uiListener!({payload:{paused:false,visible:true,clickThrough:true}});
    await vi.waitFor(()=>expect(bridge.setInputAvailable).toHaveBeenLastCalledWith(false));
  });
  it("retains a performance toggle changed while the initial model is loading",async()=>{
    let finishMount!:(value:WidgetController)=>void;
    native.mountModel.mockImplementationOnce(()=>new Promise<WidgetController>(resolve=>{finishMount=resolve;}));
    const ready=startPet();
    await vi.waitFor(()=>expect(finishMount).toBeDefined());
    const next=structuredClone(settings);next.preferences.performanceOverlay=true;
    settingsListener!({payload:next});finishMount(controller);
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    expect(controller.setPerformanceVisible).toHaveBeenLastCalledWith(true);
    expect(native.mountModel).toHaveBeenCalledOnce();
  });
  it("toggles performance metrics without recreating the model or DSH connection",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    expect(controller.setPerformanceVisible).toHaveBeenLastCalledWith(false);
    const next=structuredClone(settings);next.preferences.performanceOverlay=true;
    settingsListener!({payload:next});
    expect(controller.setPerformanceVisible).toHaveBeenLastCalledWith(true);
    settingsListener!({payload:structuredClone(settings)});
    expect(controller.setPerformanceVisible).toHaveBeenLastCalledWith(false);
    expect(native.mountModel).toHaveBeenCalledOnce();expect(native.connection).toHaveBeenCalledOnce();
  });
  it("shows native sampling points only with both debug and lighting enabled and clears on pause",async()=>{
    controller.setEnvironmentLighting=vi.fn();
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async(command,...args)=>command==="sample_environment_color"
      ?{color:"#204a9e",viewportWidth:innerWidth,viewportHeight:innerHeight,patches:[{left:100,top:100,width:12,height:12}]}
      :original(command,...args));
    const ready=startPet();await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector("[data-environment-samples]")).toBeNull();
    const next=structuredClone(settings);next.preferences.performanceOverlay=true;
    settingsListener!({payload:next});await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelectorAll("[data-environment-sample]")).toHaveLength(1);
    expect(native.invoke).toHaveBeenCalledWith("sample_environment_color",{overlays:expect.objectContaining({viewportWidth:innerWidth,viewportHeight:innerHeight})});
    next.preferences.environmentLightingEnabled=false;settingsListener!({payload:structuredClone(next)});
    expect(document.querySelector("[data-environment-samples]")).toBeNull();
    next.preferences.environmentLightingEnabled=true;settingsListener!({payload:structuredClone(next)});await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelectorAll("[data-environment-sample]")).toHaveLength(1);
    trayListener!({payload:"pause"});expect(document.querySelector("[data-environment-samples]")).toBeNull();
    expect(native.mountModel).toHaveBeenCalledOnce();
  });
  it("resynchronizes a paused portrait and static question region after DPI resize without remounting",async()=>{
    vi.stubGlobal("innerWidth",576);vi.stubGlobal("innerHeight",720);
    let report:Parameters<WidgetController["observeInteractionMask"]>[0];
    vi.mocked(controller.observeInteractionMask).mockImplementation(listener=>{report=listener;});
    controller.setHostPosition=vi.fn();
    try{
      const ready=startPet();
      await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
      await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
      report!({width:4,height:2,left:0,top:468,displayWidth:576,displayHeight:736,viewportWidth:576,viewportHeight:720,bits:new Uint8Array([6])});
      const bubble=document.querySelector<HTMLOutputElement>("#bubble")!;
      bubble.hidden=false;bubble.dataset.interactive="true";
      vi.spyOn(bubble,"getBoundingClientRect").mockReturnValue({left:144,top:100,right:432,bottom:200,width:288,height:100} as DOMRect);
      trayListener!({payload:"pause"});
      const mounts=native.mountModel.mock.calls.length,destroys=vi.mocked(controller.destroy).mock.calls.length;
      vi.mocked(controller.resume).mockClear();vi.mocked(controller.setHostPosition).mockClear();
      vi.stubGlobal("innerHeight",1204);globalThis.dispatchEvent(new Event("resize"));
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_model_hit_mask",{mask:expect.objectContaining({viewportWidth:576,viewportHeight:1204,bits:[6]})}));
      await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledWith("set_bubble_interaction_region",{region:{left:144,top:100,width:288,height:100,viewportWidth:576,viewportHeight:1204}}));
      await vi.waitFor(()=>expect(controller.setHostPosition).toHaveBeenCalled());
      expect(controller.status).toBe("paused");expect(controller.resume).not.toHaveBeenCalled();
      expect(native.mountModel).toHaveBeenCalledTimes(mounts);expect(controller.destroy).toHaveBeenCalledTimes(destroys);
    }finally{vi.unstubAllGlobals();}
  });

  it("keeps the immutable native launch ahead of a newer plugin current URL during cold startup",async()=>{
    const other=INITIAL_URL.replace("41234","41235");
    native.getCurrent.mockResolvedValue([other]);
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());
    const bridge=native.connection.mock.results[0]!.value;
    expect(bridge.connect).toHaveBeenCalledExactlyOnceWith(INITIAL_URL);
    finishDeepLinks!();await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    expect(bridge.connect.mock.calls.at(-1)![0]).toBe(other);
    expect(bridge.connect.mock.calls[0]![0]).toBe(INITIAL_URL);
  });

  it("buffers the first valid runtime launches during model preparation without invalid URLs occupying the buffer",async()=>{
    let finishModel!: (value:DesktopSettings)=>void;
    native.invoke.mockImplementation(async command=>command==="get_settings"?structuredClone(settings):command==="prepare_model"?new Promise(resolve=>{finishModel=resolve;}):command==="get_initial_connection"?INITIAL_URL:command==="get_pet_ui_state"?{paused:false,visible:true,clickThrough:false}:undefined);
    const ready=startPet();
    await vi.waitFor(()=>expect(finishModel).toBeDefined());
    const first=INITIAL_URL.replace("41234","41235"),later=INITIAL_URL.replace("41234","41236");
    deepLinkListener!(["invalid",first,later]);
    finishModel(structuredClone(settings));
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    expect(bridge.connect.mock.calls.map((row:string[])=>row[0])).toEqual([INITIAL_URL,INITIAL_URL,first,later,INITIAL_URL]);
  });

  it("automatically connects a waiting Host only when the original offline lease expires",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    callbacks.onDisconnected();await vi.advanceTimersByTimeAsync(30_000);
    bridge.connect.mockReturnValue("conflict");deepLinkListener!([INITIAL_URL.replace("41234","41235")]);
    bridge.connectPending.mockImplementationOnce(()=>{queueMicrotask(()=>callbacks.onConnected());return true;});
    await vi.advanceTimersByTimeAsync(29_999);expect(bridge.connectPending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(bridge.connectPending).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
    await vi.advanceTimersByTimeAsync(60_000);expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
  });

  it("retains the original Host when it recovers before expiry and does not connect the waiting Host",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    callbacks.onDisconnected();bridge.connect.mockReturnValue("conflict");deepLinkListener!([INITIAL_URL.replace("41234","41235")]);
    await vi.advanceTimersByTimeAsync(30_000);callbacks.onConnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.connectPending).not.toHaveBeenCalled();expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
  });

  it("keeps the successor's own bounded failure period without letting duplicate launches extend it",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    callbacks.onDisconnected();bridge.connectPending.mockReturnValueOnce(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
    await vi.advanceTimersByTimeAsync(30_000);bridge.connect.mockReturnValue("unchanged");deepLinkListener!([INITIAL_URL]);
    await vi.advanceTimersByTimeAsync(29_999);expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
    await vi.advanceTimersByTimeAsync(1);expect(native.invoke).toHaveBeenCalledWith("exit_app");
  });

  it.each(["unchanged","conflict"])("does not hide or reset the model for a %s launch",async admission=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    const bubble=document.querySelector<HTMLOutputElement>("#bubble")!;bubble.hidden=false;bubble.textContent="Original Host";
    const hide=native.getCurrentWindow.mock.results[0]!.value.hide;
    const previousHides=hide.mock.calls.length,previousMounts=native.mountModel.mock.calls.length;
    bridge.connect.mockImplementation(()=>{if(admission==="conflict")callbacks.onConflict();return admission;});
    deepLinkListener!(["dsh-inochi2d-pet://connect?fixture=another-host"]);
    await Promise.resolve();
    expect(hide).toHaveBeenCalledTimes(previousHides);expect(native.mountModel).toHaveBeenCalledTimes(previousMounts);
    expect(bubble.hidden).toBe(false);expect(bubble.textContent).toBe("Original Host");expect(controller.status).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
    if(admission==="conflict")expect(native.message).toHaveBeenCalledWith(expect.stringContaining("正常退出后会立即接管"),expect.objectContaining({kind:"info"}));
    else expect(native.message).not.toHaveBeenCalled();
  });
  it("pauses immediately while offline and reuses the mounted model when the Host returns",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    // WebView visibility notifications may arrive after the Host has stopped.
    native.getCurrentWindow.mock.results[0]!.value.hide.mockImplementation(async()=>undefined);
    const destroyed=vi.mocked(controller.destroy).mock.calls.length;
    callbacks.onDisconnected();
    expect(document.visibilityState).toBe("visible");expect(controller.status).toBe("paused");
    await vi.advanceTimersByTimeAsync(100);
    callbacks.onConnected();
    await vi.waitFor(()=>expect(controller.status).toBe("running"));
    expect(native.mountModel).toHaveBeenCalledOnce();expect(controller.destroy).toHaveBeenCalledTimes(destroyed);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
  });
  it("does not extend the original Host's reconnect period for a refused launch",async()=>{
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const bridge=native.connection.mock.results[0]!.value;
    const callbacks=native.connection.mock.calls[0]![0] as ConnectionCallbacks;
    callbacks.onDisconnected();await vi.advanceTimersByTimeAsync(30_000);
    bridge.connect.mockReturnValue("conflict");
    deepLinkListener!(["dsh-inochi2d-pet://connect?fixture=another-host"]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(native.invoke).not.toHaveBeenCalledWith("exit_app");
    await vi.advanceTimersByTimeAsync(1);
    expect(native.invoke).toHaveBeenCalledWith("exit_app");
  });
  it("keeps a disabled model hidden without mounting, bubbles or input interception", async () => {
    const disabled = {...structuredClone(settings),activeModelId:null};
    native.invoke.mockImplementation(async command => command === "get_settings" || command === "prepare_model" ? disabled : command==="get_pet_ui_state"?{paused:false,visible:true,clickThrough:false}:undefined);
    const ready = startPet();
    await vi.waitFor(() => expect(finishDeepLinks).toBeDefined());
    finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());
    finishTraySubscription!(); await ready;
    expect(native.mountModel).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalledWith("open_settings");
    expect(document.querySelector<HTMLOutputElement>("#bubble")!.hidden).toBe(true);
    const bridge = native.connection.mock.results[0]!.value;
    expect(bridge.setInputAvailable).toHaveBeenCalledWith(false);
  });

  it("destroys an active model on disable and remounts on enable while retaining the connection", async () => {
    const ready = startPet();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());
    finishTraySubscription!(); await ready;
    vi.mocked(controller.destroy).mockClear();
    const disabled = {...structuredClone(settings),activeModelId:null};
    settingsListener!({payload:disabled});
    await vi.waitFor(() => expect(controller.destroy).toHaveBeenCalled());
    expect(native.mountModel).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLOutputElement>("#bubble")!.hidden).toBe(true);
    changeVisibility("visible");
    vi.mocked(controller.resume).mockClear();
    changeVisibility("hidden"); changeVisibility("visible");
    expect(controller.resume).not.toHaveBeenCalled();
    settingsListener!({payload:structuredClone(settings)});
    await vi.waitFor(() => expect(native.mountModel).toHaveBeenCalledTimes(2));
    expect(native.connection).toHaveBeenCalledTimes(1);
  });

  it("switches the selected model without changing the DSH connection", async () => {
    const ready = startPet();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());
    finishTraySubscription!(); await ready;
    const next = structuredClone(settings);
    next.models.push({...structuredClone(next.models[0]!),id:"second",title:"Second",modelPath:"C:\\fixture\\second.vrm"});
    next.activeModelId = "second";
    settingsListener!({payload:next});
    await vi.waitFor(() => expect(native.mountModel).toHaveBeenCalledTimes(2));
    expect(native.mountModel.mock.calls[1]![1]).toMatchObject({activeModelId:"second"});
    expect(native.connection).toHaveBeenCalledTimes(1);
  });

  it("reprojects the current bubble anchor on resize and clears it while replacing a model", async () => {
    const anchor=document.querySelector<HTMLElement>("#pet-view")!,host=document.querySelector<HTMLElement>("#model")!;
    let y=20;
    controller.getBubbleAnchor=vi.fn(()=>({x:100,y}));
    const ready=startPet();
    await vi.waitFor(()=>expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(()=>expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    const nativeResizes=native.invoke.mock.calls.filter(([command])=>command==="set_model_viewport").length;
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("926px");
    y=35;host.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true}));
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("941px");
    y=40;globalThis.dispatchEvent(new Event("resize"));
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("946px");
    const resized=structuredClone(settings);resized.preferences.scale=.8;
    vi.mocked(controller.setDisplaySize!).mockImplementation(()=>{y=50;});
    settingsListener!({payload:resized});
    await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-top")).toBe("894px"));
    const second={...controller,getBubbleAnchor:vi.fn(()=>({x:125,y:120}))};
    let finishMount!:(value:WidgetController)=>void;
    native.mountModel.mockImplementationOnce(()=>new Promise<WidgetController>(resolve=>{finishMount=resolve;}));
    const next=structuredClone(resized);next.models.push({...structuredClone(next.models[0]!),id:"second",modelPath:"C:\\fixture\\second.vrm"});next.activeModelId="second";
    settingsListener!({payload:next});
    await vi.waitFor(()=>expect(native.mountModel).toHaveBeenCalledTimes(2));
    expect(anchor.style.getPropertyValue("--bubble-top")).toBe("844px");
    const oldReads=vi.mocked(controller.getBubbleAnchor).mock.calls.length;
    host.dispatchEvent(new CustomEvent("model-viewport-change",{bubbles:true}));
    expect(controller.getBubbleAnchor).toHaveBeenCalledTimes(oldReads);
    finishMount(second);
    await vi.waitFor(()=>expect(anchor.style.getPropertyValue("--bubble-top")).toBe("964px"));
    expect(anchor.style.getPropertyValue("--bubble-left")).toBe("365px");
    expect(native.invoke.mock.calls.filter(([command])=>command==="set_model_viewport")).toHaveLength(nativeResizes+1);
    expect(native.connection).toHaveBeenCalledTimes(1);
  });

  it("applies mapping and privacy edits without remounting the renderer", async () => {
    const ready = startPet();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());
    finishTraySubscription!(); await ready;
    const next = structuredClone(settings);
    next.models[0]!.mappings.click = ["Idle"];
    next.preferences.privacyMode = true;
    settingsListener!({payload:next});
    await vi.waitFor(() => expect(native.connection.mock.results[0]!.value.setInputAvailable).toHaveBeenLastCalledWith(false));
    expect(native.mountModel).toHaveBeenCalledTimes(1);
  });

  it("previews only the active model and saves calibration without recreating its renderer", async () => {
    const ready = startPet();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());finishTraySubscription!();await ready;
    vi.mocked(controller.setModelAdjustments!).mockClear();
    adjustmentListener!({payload:{modelId:"other",adjustments:{idle:{armLiftDegrees:25}}}});
    expect(controller.setModelAdjustments).not.toHaveBeenCalled();
    adjustmentListener!({payload:{modelId:"fixture",adjustments:{idle:{armLiftDegrees:12}}}});
    expect(controller.setModelAdjustments).toHaveBeenLastCalledWith({idle:{armLiftDegrees:12}});
    const next=structuredClone(settings);next.models[0]!.adjustments={idle:{armLiftDegrees:12},gaze:{headStrength:.7}};
    settingsListener!({payload:next});
    expect(controller.setModelAdjustments).toHaveBeenLastCalledWith(next.models[0]!.adjustments);
    const reset=structuredClone(next);reset.models[0]!.adjustments={};settingsListener!({payload:reset});
    expect(controller.setModelAdjustments).toHaveBeenLastCalledWith({});
    expect(native.mountModel).toHaveBeenCalledTimes(1);expect(native.connection).toHaveBeenCalledTimes(1);
  });

  it("resumes a mounted model when a fast DSH connection shows the window while native subscriptions are still pending", async () => {
    let initialized = false;
    const ready = startPet().then(() => {initialized = true;});
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    expect(initialized).toBe(false);
    expect(controller.pause).toHaveBeenCalled();
    expect(controller.status).toBe("running");
    expect(controller.resume).toHaveBeenCalled();

    finishDeepLinks!();
    await vi.waitFor(() => expect(finishTraySubscription).toBeDefined());
    changeVisibility("hidden"); expect(controller.status).toBe("paused");
    changeVisibility("visible"); expect(controller.status).toBe("running");
    finishTraySubscription!(); await ready;

    trayListener!({payload: "pause"}); expect(controller.status).toBe("paused");
    changeVisibility("hidden"); changeVisibility("visible"); expect(controller.status).toBe("paused");
    changeVisibility("hidden"); trayListener!({payload: "resume"}); expect(controller.status).toBe("paused");
    changeVisibility("visible"); expect(controller.status).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
    globalThis.dispatchEvent(new Event("pagehide"));
    vi.mocked(controller.resume).mockClear();
    changeVisibility("hidden"); changeVisibility("visible"); expect(controller.resume).not.toHaveBeenCalled();
  });
});
