// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings } from "../src/types.js";
import type { WidgetController } from "../src/vendor-types.js";
import { startPet } from "../src/pet.js";

const native = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), getCurrent: vi.fn(), onOpenUrl: vi.fn(),
  getCurrentWindow: vi.fn(), availableMonitors: vi.fn(), primaryMonitor: vi.fn(),
  createModelSlot: vi.fn(), mountModel: vi.fn(), connection: vi.fn(), message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({invoke: native.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen: native.listen}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: native.getCurrentWindow, availableMonitors: native.availableMonitors,
  primaryMonitor: native.primaryMonitor, PhysicalPosition: class {constructor(readonly x: number, readonly y: number) {}},
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({getCurrent: native.getCurrent, onOpenUrl: native.onOpenUrl}));
vi.mock("@tauri-apps/plugin-dialog", () => ({message:native.message}));
vi.mock("../src/renderer.js", () => ({createModelSlot: native.createModelSlot, mountModel: native.mountModel}));
vi.mock("../src/connection.js", () => ({StatusConnection: class {
  constructor(callbacks: unknown) { return native.connection(callbacks); }
}}));

interface ConnectionCallbacks {onConnected(): void; onDisconnected(): void; onSnapshot(value: unknown): void; onConflict(): void}
const settings: DesktopSettings = {
  schemaVersion: 4,
  preferences: {fps: 30, maxDevicePixelRatio: 1.5, scale: .67, privacyMode: false, bubbleMode: "compact"},
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
let deepLinkListener: ((urls:string[])=>void) | undefined;

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
    observeInteractionMask: vi.fn(), setPointerPosition: vi.fn(), destroy: vi.fn(),
  };
  const monitor = {position: {x: 0, y: 0}, size: {width: 1920, height: 1080}, workArea: {position: {x: 0, y: 0}}};
  native.availableMonitors.mockResolvedValue([monitor]); native.primaryMonitor.mockResolvedValue(monitor);
  show = vi.fn(async () => changeVisibility("visible"));
  native.getCurrentWindow.mockReturnValue({
    show, hide: vi.fn(async () => changeVisibility("hidden")),
    onMoved: vi.fn(async () => () => undefined), outerPosition: vi.fn(async () => ({x: 400, y: 400})),
    outerSize: vi.fn(async () => ({width: 320, height: 480})), setPosition: vi.fn(async () => undefined),
  });
  native.invoke.mockImplementation(async command => command === "get_settings" || command === "prepare_model" ? structuredClone(settings) : undefined);
  native.listen.mockImplementation(async (event, listener) => {
    if (event === "tray-action") {
      trayListener = listener;
      await new Promise<void>(resolve => {finishTraySubscription = resolve;});
    }
    if (event === "settings-changed") settingsListener = listener;
    return () => undefined;
  });
  native.getCurrent.mockResolvedValue(["dsh-inochi2d-pet://connect?fixture=memory-only"]);
  native.onOpenUrl.mockImplementation(listener => {deepLinkListener=listener;return new Promise<() => void>(resolve => {finishDeepLinks = () => resolve(() => undefined);});});
  native.message.mockResolvedValue(undefined);
  native.createModelSlot.mockResolvedValue({
    mount: (factory: (signal: AbortSignal) => Promise<WidgetController>) => factory(new AbortController().signal),
    destroy: vi.fn(() => controller.destroy()),
  });
  native.mountModel.mockResolvedValue(controller);
  native.connection.mockImplementation((callbacks: ConnectionCallbacks) => ({
    connect: vi.fn(() => {queueMicrotask(() => {
      callbacks.onConnected();
      callbacks.onSnapshot({protocolVersion: 1, sequence: 1, emittedAt: 1, state: "idle"});
    });return "accepted";}),
    stop: vi.fn(), setInputAvailable: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  finishDeepLinks?.(); finishTraySubscription?.();
  globalThis.dispatchEvent(new Event("pagehide"));
  await Promise.resolve(); await Promise.resolve();
  finishDeepLinks = undefined; finishTraySubscription = undefined; trayListener = undefined; settingsListener = undefined;deepLinkListener=undefined;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks();
});

describe("desktop hidden-window startup", () => {
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
    if(admission==="conflict")expect(native.message).toHaveBeenCalledWith(expect.stringContaining("等待 StarLite 托盘图标退出"),expect.objectContaining({kind:"info"}));
    else expect(native.message).not.toHaveBeenCalled();
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
    native.invoke.mockImplementation(async command => command === "get_settings" || command === "prepare_model" ? disabled : undefined);
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
