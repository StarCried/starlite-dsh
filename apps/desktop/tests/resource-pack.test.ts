// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSettings } from "../src/settings.js";
import type { DesktopSettings } from "../src/types.js";
import type { StarterPackInspection } from "../src/resource-pack-dialog.js";

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
const page = readFileSync("apps/desktop/index.html", "utf8").match(/<main id="settings-view"[\s\S]+?<\/main>/u)![0];
const path = "C:\\Downloads\\character.zip";
const pack = {title:"测试角色",license:"仅供本地使用。<img src=x>",sha256:"a".repeat(64),animationCount:3};
const starter: StarterPackInspection = {...pack,path:"C:\\Users\\test\\StarLite\\starter-character.zip",modelSha256:"b".repeat(64)};
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
afterEach(() => vi.unstubAllGlobals());

async function launch(current: DesktopSettings = empty, available: StarterPackInspection | Error | null = null) {
  native.invoke.mockImplementation(async (command: string, args?: {preferences: DesktopSettings["preferences"]}) => {
    if (command === "get_settings") return structuredClone(current);
    if (command === "get_starter_pack") {
      if (available instanceof Error) throw available;
      return available;
    }
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

describe("resource package onboarding", () => {
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
      preferences:{...preferences,fps:30,maxDevicePixelRatio:1.5},
    });
    expect(idle().value).toBe("RelaxedBreath");
    expect(document.querySelector<HTMLSelectElement>('select[data-state="working"]')!.value).toBe("Typing");
    expect(document.querySelector<HTMLInputElement>('[data-pool="click"] input:checked')!.value).toBe("HighWave");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector("#save-settings")!.textContent).toBe("保存设置");
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","get_starter_pack","inspect_resource_pack","install_resource_pack"]);
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
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","get_starter_pack","inspect_resource_pack"]);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("preserves existing display and privacy preferences during replacement", async () => {
    await launch(installed);
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({preferences}));
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
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({preferences}));
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

  it("offers the acquired character license on first launch and imports without any picker", async () => {
    await launch(empty, starter);
    expect(document.querySelector("dialog[open]")).not.toBeNull();
    expect(native.open).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalledWith("install_resource_pack", expect.anything());
    accept().click();
    await vi.waitFor(() => expect(document.querySelector("#inspection-status")!.textContent).toContain("自动导入并保存"));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", {
      path:starter.path,expectedSha256:starter.sha256,acceptLicense:true,
      preferences:{...preferences,fps:30,maxDevicePixelRatio:1.5},
    });
    expect(document.querySelector<HTMLElement>("#starter-character")!.hidden).toBe(true);
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","get_starter_pack","install_resource_pack"]);
  });

  it("can decline automatic onboarding and still manually import a different pack", async () => {
    await launch(empty, starter);
    document.querySelector("dialog")!.dispatchEvent(new Event("cancel", {cancelable:true}));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).not.toHaveBeenCalledWith("install_resource_pack", expect.anything());
    expect(document.querySelector<HTMLElement>("#starter-character")!.hidden).toBe(false);
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({path}));
  });

  it("preserves an existing user model until explicit replacement and retains its preferences", async () => {
    const other = structuredClone(installed);
    other.model!.sourceSha256 = "c".repeat(64);
    await launch(other, starter);
    expect(document.querySelector("dialog")).toBeNull();
    expect(idle().value).toBe("RelaxedBreath");
    document.querySelector<HTMLButtonElement>("#use-starter-character")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({path:starter.path,preferences}));
  });

  it("does not ask again or import again when the starter model is already installed", async () => {
    await launch(installed, starter);
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector<HTMLElement>("#starter-character")!.hidden).toBe(true);
    expect(native.open).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["get_settings","get_starter_pack"]);
  });

  it("explains acquisition failure without losing the current model or disabling manual import", async () => {
    await launch(installed, new Error("微光资源准备失败，请重启 DSH 重试。"));
    expect(document.querySelector("#inspection-status")!.textContent).toContain("重启 DSH");
    expect(document.querySelector("#settings-error")!.textContent).toContain("资源准备失败");
    expect(idle().value).toBe("RelaxedBreath");
    expect(button().disabled).toBe(false);
    await inspect();
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(native.invoke).toHaveBeenCalledWith("install_resource_pack", expect.objectContaining({path,preferences}));
  });

  it("restores manual controls after an acquired pack changes before consent is committed", async () => {
    await launch(empty, starter);
    native.invoke.mockImplementationOnce(async () => { throw new Error("resource pack changed after inspection"); });
    accept().click();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(document.querySelector("#settings-error")!.textContent).toContain("changed after inspection");
    expect(idle().value).toBe("");
    expect(document.querySelector<HTMLButtonElement>("#choose-model")!.disabled).toBe(false);
    expect(document.querySelector<HTMLElement>("#starter-character")!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>("#use-starter-character")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    accept().click();
    await vi.waitFor(() => expect(idle().value).toBe("RelaxedBreath"));
  });
});
