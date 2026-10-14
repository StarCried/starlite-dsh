// @vitest-environment happy-dom
import {beforeEach, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {modelConfig} from "../src/renderer.js";
import {startSettings} from "../src/settings.js";
import type {DesktopSettings, LibraryModel, ModelInspection, ModelInstallRequest} from "../src/types.js";
const {invoke, open} = vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke,convertFileSrc:(path:string) => "asset:" + path}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open}));
vi.mock("@tauri-apps/api/event", () => ({listen:vi.fn(async () => () => {})}));
const preferences = {fps:60 as const,maxDevicePixelRatio:1.5,scale:1,privacyMode:false,bubbleMode:"compact" as const};
const mappings = {idle:"StarLiteIdle",working:null,blocked:null,approval:null,completed:null,error:null,click:[],ambient:[]};
const catalog = [{name:"StarLiteIdle",durationMs:6000}];
const initial:DesktopSettings = {schemaVersion:4,preferences,models:[],activeModelId:null};
const model:LibraryModel = {id:"model-one",title:"One",backend:"vrm",modelPath:"m.vrm",sourceSha256:"hash",mappings,animations:catalog,vrm:{animations:[{name:"StarLiteIdle",path:"a.vrma"}],embeddedAnimations:[],profilePath:"p.json"}};
const installed:DesktopSettings = {...initial,models:[model],activeModelId:model.id};
const inspected:ModelInspection = {backend:"vrm",sourceSha256:"hash",sourceBytes:32,compatibilitySupported:true,animations:catalog,defaultMappings:mappings,issues:[]};
const add = () => document.getElementById("add-model") as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("Option",function(text:string,value:string){const option=document.createElement("option");option.textContent=text;option.value=value;return option;});
  document.body.innerHTML=readFileSync(resolve(import.meta.dirname,"../index.html"),"utf8").replace(/<script[\s\S]*?<\/script>/gu,"");
  invoke.mockImplementation(async (command:string) => {
    if(command === "get_settings" || command === "prepare_model") return initial;
    if(command === "inspect_model") return inspected;
    if(command === "install_model") return installed;
    throw Error(command);
  });
});

it("maps both embedded and external actions without a resource package", () => {
  expect(modelConfig(installed)).toMatchObject({backend:"vrm",model:"asset:m.vrm",embeddedAnimations:[],animations:[{name:"StarLiteIdle",url:"asset:a.vrma"}],profile:"asset:p.json",ambient:{animations:["StarLiteIdle"]},render:{viewportPadding:{left:128,top:64,right:128,bottom:192}},camera:{pitchDegrees:5,targetHeight:.54}});
  expect(modelConfig({...installed,models:[{...model,vrm:{...model.vrm!,embeddedAnimations:["Wave"]}}]}).embeddedAnimations).toEqual(["Wave"]);
  expect(modelConfig(installed).neutralAnimation).toBe("StarLiteIdle");
  expect(() => modelConfig({...installed,activeModelId:null})).toThrow();
  expect(() => modelConfig({...installed,models:[{...model,backend:"inochi2d"}]})).toThrow("Inochi2D is disabled");
});

it("selects and imports one VRM with bundled Idle without extra dialogs or mappings", async () => {
  await startSettings();open.mockResolvedValue("C:/models/pet.vrm");add().click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("install_model",{request:{backend:"vrm",sourcePath:"C:/models/pet.vrm",animationSources:[],mappings,preferences}}));
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(expect.objectContaining({filters:[{name:"VRM",extensions:["vrm"]}]}));
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector('[data-model-id="model-one"]')).not.toBeNull();
  expect(document.getElementById("save-settings")).toBeNull();
  expect(document.body.textContent).not.toContain("ZIP");
});

it("uses inspected action defaults and leaves unmapped events disabled", async () => {
  await startSettings();
  invoke.mockImplementation(async (command:string,args?:{request:ModelInstallRequest}) => {
    if(command === "inspect_model") return {...inspected,animations:[...catalog,{name:"Wave",durationMs:1000}],defaultMappings:{...mappings,click:["Wave"]}};
    if(command === "install_model") return {...installed,models:[{...model,mappings:args!.request.mappings}]};
    throw Error(command);
  });
  open.mockResolvedValue("pet.vrm");add().click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("install_model",{request:expect.objectContaining({mappings:{...mappings,click:["Wave"]}})}));
});

it("cancelling the picker performs no inspection or installation", async () => {
  await startSettings();open.mockResolvedValue(null);add().click();
  await vi.waitFor(() => expect(add().disabled).toBe(false));
  expect(invoke.mock.calls.some(([command]) => command === "inspect_model" || command === "install_model")).toBe(false);
});

it("preserves the current model after invalid VRM inspection", async () => {
  invoke.mockResolvedValue(installed);await startSettings();
  invoke.mockRejectedValueOnce(new Error("invalid model"));open.mockResolvedValue("new.vrm");add().click();
  await vi.waitFor(() => expect(document.getElementById("settings-error")!.textContent).toContain("invalid model"));
  expect(add().disabled).toBe(false);
  expect(document.querySelector('[data-model-id="model-one"]')).not.toBeNull();
  expect(invoke.mock.calls.some(([command]) => command === "install_model")).toBe(false);
});

it("rejects ZIP and Inochi2D even when returned by the picker", async () => {
  await startSettings();
  for(const path of ["old.inp","retired.zip"]) {
    open.mockResolvedValueOnce(path);add().click();
    await vi.waitFor(() => expect(add().disabled).toBe(false));
    expect(document.getElementById("settings-error")!.textContent).toContain(".vrm");
  }
  expect(invoke.mock.calls.some(([command]) => command === "inspect_model")).toBe(false);
});

it("blocks duplicate imports", async () => {
  await startSettings();let finish!:(value:null)=>void;
  open.mockImplementation(() => new Promise(resolve => {finish=resolve;}));add().click();add().click();
  expect(open).toHaveBeenCalledOnce();
  finish(null);await vi.waitFor(() => expect(add().disabled).toBe(false));
});

it("keeps import instructions behind a formatted, read-only document dialog", async () => {
  await startSettings();invoke.mockClear();
  expect(add().textContent).toBe("＋ 添加 VRM 模型");
  expect(document.body.textContent).not.toContain("Humanoid");
  const help = document.getElementById("model-import-help") as HTMLButtonElement;
  expect(help.closest("button")).toBe(help);
  expect(help.parentElement).toBe(add().parentElement);
  help.click();
  const dialog = document.querySelector<HTMLDialogElement>(".model-import-dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute("aria-label")).toBe("VRM 模型导入说明");
  expect([...dialog.querySelectorAll(".license-content h3")].map(item => item.textContent)).toContain("人形骨骼");
  expect(dialog.textContent).toContain("Humanoid");
  expect(dialog.textContent).toContain("blinkLeft");
  expect(dialog.textContent).toContain("lookAt");
  expect(dialog.querySelector("pre code")!.textContent).toContain("rightLowerLeg");
  expect(dialog.textContent).not.toContain("**");
  expect(open).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
  dialog.querySelector<HTMLButtonElement>("button")!.click();
  expect(document.querySelector("dialog")).toBeNull();
  help.click();
  document.querySelector<HTMLDialogElement>("dialog")!.close();
  expect(document.querySelector("dialog")).toBeNull();
});
