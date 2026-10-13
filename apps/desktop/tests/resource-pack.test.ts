// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSettings } from "../src/settings.js";
import type { DesktopSettings } from "../src/types.js";

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
const page = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8").match(/<main id="settings-view"[\s\S]+?<\/main>/u)![0];
const path = "C:\\Downloads\\character.zip";
const pack = {title:"测试角色",license:"仅供本地使用。<img src=x>",sha256:"a".repeat(64),animationCount:3};
const preferences = {fps:60 as const,maxDevicePixelRatio:1.2,scale:0.67,privacyMode:true,bubbleMode:"detailed" as const};
const empty: DesktopSettings = {schemaVersion:3,preferences};
const installed: DesktopSettings = {
  schemaVersion:3,preferences,
  model:{backend:"vrm",modelPath:"C:\\models\\model.vrm",sourceSha256:"b".repeat(64),
    animations:[{name:"RelaxedBreath",durationMs:4000},{name:"Typing",durationMs:2000},{name:"HighWave",durationMs:3000}],
    mappings:{idle:"RelaxedBreath",working:"Typing",completed:null,error:null,blocked:null,approval:null,click:["HighWave"],ambient:[]},
    vrm:{animations:[]}},
};
const button = () => document.querySelector<HTMLButtonElement>("#import-resource-pack")!;
const accept = () => document.querySelector<HTMLButtonElement>("dialog .primary")!;
const idle = () => document.querySelector<HTMLSelectElement>('select[data-state="idle"]')!;

beforeEach(() => {
  document.body.innerHTML = page;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  // happy-dom lacks the browser's Option convenience constructor.
  vi.stubGlobal("Option", function Option(text: string, value: string) {
    const option = document.createElement("option");
    option.textContent = text;
    option.value = value;
    return option;
  });
  native.invoke.mockReset();
  native.open.mockReset().mockResolvedValue(path);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function launch(current: DesktopSettings = empty, prepared: DesktopSettings | Error = current) {
  native.invoke.mockImplementation(async (command: string, args?: {preferences: DesktopSettings["preferences"]; enabled?: boolean}) => {
    if (command === "get_settings") return structuredClone(current);
    if (command === "prepare_model") {
      if (prepared instanceof Error) throw prepared;
      return structuredClone(prepared);
    }
    if (command === "get_model_license") return {title:pack.title,text:pack.license};
    if (command === "use_default_model") return {...structuredClone(installed),preferences:{...args!.preferences,modelEnabled:true}};
    if (command === "set_model_enabled") return {...structuredClone(current),preferences:{...current.preferences,modelEnabled:args!.enabled}};
    if (command === "inspect_resource_pack") return pack;
    if (command === "install_resource_pack") return {...structuredClone(installed),preferences:args!.preferences};
    throw new Error(`unexpected command: ${command}`);
  });
  await startSettings();
}

async function inspect() {
  button().click();
  await vi.waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
}

describe("resource packages and default character", () => {
  it("requires license consent, then installs the entire authored mapping without manual save", async () => {
    await launch();
    await inspect();
    expect(native.invoke).not.toHaveBeenCalledWith("install_resource_pack", expect.anything());
    expect(document.querySelector("dialog img")).toBeNull();
    expect(document.querySelector("dialog pre")!.textContent).toContain("<img src=x>");
    accept().click();
    await vi.waitFor(() => expect(document.querySelector("#inspection-status")!.textContent).toContain("自动导入并保存"));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", {
      path,expectedSha256:pack.sha256,acceptLicense:true,
      preferences:{...preferences,modelEnabled:true,fps:30,maxDevicePixelRatio:1.5},
    });
    expect(idle().value).toBe("RelaxedBreath");
    expect(document.querySelector<HTMLSelectElement>('select[data-state="working"]')!.value).toBe("Typing");
    expect(document.querySelector<HTMLInputElement>('[data-pool="click"] input:checked')!.value).toBe("HighWave");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector("#save-settings")!.textContent).toBe("保存设置");
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","prepare_model","inspect_resource_pack","install_resource_pack"]);
  });

  it("cancelling the picker or license preserves the installed model", async () => {
    await launch(installed);
    native.open.mockResolvedValueOnce(null);
    button().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledTimes(2);
    await inspect();
    document.querySelector("dialog")!.dispatchEvent(new Event("cancel", {cancelable:true}));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(idle().value).toBe("RelaxedBreath");
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","prepare_model","inspect_resource_pack"]);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("preserves existing display and privacy preferences during replacement", async () => {
    await launch(installed);
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({preferences:{...preferences,modelEnabled:true}}));
    expect(document.querySelector<HTMLInputElement>("#scale")!.value).toBe("0.67");
    expect(document.querySelector<HTMLInputElement>("#privacy")!.checked).toBe(true);
  });

  it("preserves preferences edited before the first import", async () => {
    await launch();
    const fps = document.querySelector<HTMLSelectElement>("#fps")!;
    fps.value = "60";
    fps.dispatchEvent(new Event("change", {bubbles:true}));
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({preferences:{...preferences,modelEnabled:true}}));
  });

  it("retains the current model and restores controls when checking or committing fails", async () => {
    await launch(installed);
    native.invoke.mockImplementationOnce(async () => { throw new Error("SHA-256 mismatch"); });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#settings-error")!.textContent).toContain("SHA-256 mismatch"));
    expect(document.querySelector("dialog")).toBeNull();
    expect(idle().value).toBe("RelaxedBreath");
    expect(button().disabled).toBe(false);
    await inspect();
    native.invoke.mockImplementationOnce(async () => { throw new Error("package changed after inspection"); });
    accept().click();
    await vi.waitFor(() => expect(document.querySelector("#settings-error")!.textContent).toContain("package changed"));
    expect(idle().value).toBe("RelaxedBreath");
    expect(document.querySelector<HTMLButtonElement>("#choose-model")!.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#save-settings")!.disabled).toBe(false);
  });

  it("opens only one import while the picker is pending", async () => {
    await launch();
    let choose: (path: string | null) => void = () => {};
    native.open.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
    button().click();
    button().click();
    expect(native.open).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>("#save-settings")!.disabled).toBe(true);
    choose(null);
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });

  it("prepares the default model without a picker, consent dialog or first-launch marker", async () => {
    await launch(empty, installed);
    expect(document.querySelector("dialog")).toBeNull();
    expect(native.open).not.toHaveBeenCalled();
    expect(idle().value).toBe("RelaxedBreath");
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","prepare_model"]);
    expect(document.getElementById("starter-character")).toBeNull();
    expect(document.querySelector(".model-license-notice")!.textContent).toContain("如不同意，请禁用模型");
  });

  it("shows the license only on request as plain text with a close button", async () => {
    await launch(installed);
    document.querySelector<HTMLButtonElement>("#view-default-license")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    expect(native.invoke).toHaveBeenCalledWith("get_model_license");
    expect(document.querySelector("dialog img")).toBeNull();
    expect(document.querySelector("dialog pre")!.textContent).toBe(pack.license);
    expect([...document.querySelectorAll("dialog button")].map(button => button.textContent)).toEqual(["关闭"]);
    document.querySelector<HTMLButtonElement>("dialog button")!.click();
    expect(document.querySelector("dialog")).toBeNull();
    expect(native.invoke).not.toHaveBeenCalledWith("install_resource_pack", expect.anything());
  });

  it("restores the default directly and preserves display and privacy preferences", async () => {
    await launch(installed);
    document.querySelector<HTMLButtonElement>("#use-default-model")!.click();
    await vi.waitFor(() => expect(document.querySelector("#inspection-status")!.textContent).toContain("已恢复默认微光"));
    expect(native.invoke).toHaveBeenCalledWith("use_default_model", {preferences:{...preferences,modelEnabled:true}});
    expect(native.open).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
    expect(idle().value).toBe("RelaxedBreath");
  });

  it("locks the enable toggle while default restoration is pending", async () => {
    await launch({...structuredClone(installed),preferences:{...preferences,modelEnabled:false}});
    let restored: (settings: DesktopSettings) => void = () => {};
    native.invoke.mockImplementationOnce(() => new Promise<DesktopSettings>(resolve => {restored = resolve;}));
    document.querySelector<HTMLButtonElement>("#use-default-model")!.click();
    const enabled = document.querySelector<HTMLInputElement>("#model-enabled")!;
    expect(enabled.disabled).toBe(true);
    enabled.click();
    expect(native.invoke.mock.calls.some(([command]) => command === "set_model_enabled")).toBe(false);
    restored({...structuredClone(installed),preferences:{...preferences,modelEnabled:true}});
    await vi.waitFor(() => expect(enabled.disabled).toBe(false));
    expect(enabled.checked).toBe(true);
    expect(document.querySelector("#inspection-status")!.textContent).toContain("已恢复默认微光");
  });

  it("keeps a toggle request locked when model preparation finishes first", async () => {
    let prepared: (settings: DesktopSettings) => void = () => {};
    let toggled: (settings: DesktopSettings) => void = () => {};
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "get_settings") return structuredClone(empty);
      if (command === "prepare_model") return new Promise<DesktopSettings>(resolve => {prepared = resolve;});
      if (command === "set_model_enabled") return new Promise<DesktopSettings>(resolve => {toggled = resolve;});
      throw new Error(`unexpected ${command}`);
    });
    const started = startSettings();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("prepare_model"));
    const enabled = document.querySelector<HTMLInputElement>("#model-enabled")!;
    enabled.click();
    expect(enabled.disabled).toBe(true);
    prepared(structuredClone(installed));
    await started;
    expect(enabled.disabled).toBe(true);
    toggled({...structuredClone(empty),preferences:{...preferences,modelEnabled:false}});
    await vi.waitFor(() => expect(enabled.disabled).toBe(false));
    expect(enabled.checked).toBe(false);
  });

  it("can disable a missing or invalid model without an Idle mapping or save", async () => {
    await launch(empty);
    const enabled = document.querySelector<HTMLInputElement>("#model-enabled")!;
    expect(document.querySelector<HTMLButtonElement>("#save-settings")!.disabled).toBe(true);
    enabled.click();
    await vi.waitFor(() => expect(enabled.disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("set_model_enabled", {enabled:false});
    expect(enabled.checked).toBe(false);
    expect(document.querySelector("#inspection-status")!.textContent).toContain("模型已禁用");
  });

  it("does not let delayed preparation overwrite a user's disable choice", async () => {
    let prepared: (settings: DesktopSettings) => void = () => {};
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "get_settings") return structuredClone(empty);
      if (command === "prepare_model") return new Promise<DesktopSettings>(resolve => {prepared = resolve;});
      if (command === "set_model_enabled") return {...structuredClone(empty),preferences:{...preferences,modelEnabled:false}};
      throw new Error(`unexpected ${command}`);
    });
    const started = startSettings();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("prepare_model"));
    const enabled = document.querySelector<HTMLInputElement>("#model-enabled")!;
    enabled.click();
    await vi.waitFor(() => expect(enabled.disabled).toBe(false));
    prepared(structuredClone(installed));
    await started;
    expect(enabled.checked).toBe(false);
    expect(idle().value).toBe("");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("retains an installed user VRM without default replacement", async () => {
    const other = structuredClone(installed);
    other.model!.sourceSha256 = "c".repeat(64);
    await launch(other);
    expect(idle().value).toBe("RelaxedBreath");
    expect(native.invoke).not.toHaveBeenCalledWith("use_default_model", expect.anything());
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("explains preparation failure and leaves disable and manual import available", async () => {
    await launch(empty, new Error("character unavailable"));
    expect(document.querySelector("#settings-error")!.textContent).toContain("character unavailable");
    expect(button().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#model-enabled")!.disabled).toBe(false);
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(idle().value).toBe("RelaxedBreath");
  });

  it("prepares a hidden settings webview without exposing any first-use dialog", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await launch(empty, installed);
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","prepare_model"]);
    expect(idle().value).toBe("RelaxedBreath");
    expect(document.querySelector("dialog")).toBeNull();
  });
});
