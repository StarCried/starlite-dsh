// @vitest-environment happy-dom
import {beforeEach, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {modelConfig} from "../src/renderer.js";
import {startSettings} from "../src/settings.js";
import type {DesktopSettings, LibraryModel} from "../src/types.js";
const {invoke, open} = vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke,convertFileSrc:(path:string) => "asset:" + path}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open}));
vi.mock("@tauri-apps/api/event", () => ({listen:vi.fn(async () => () => {})}));
const preferences = {fps:60 as const,maxDevicePixelRatio:1.5,scale:1,privacyMode:false,bubbleMode:"compact" as const};
const mappings = {idle:"Idle",working:null,blocked:null,approval:null,completed:null,error:null,click:[],ambient:[]};
const catalog = [{name:"Idle",durationMs:1000}];
const initial:DesktopSettings = {schemaVersion:4,preferences,models:[],activeModelId:null};
const model:LibraryModel = {id:"model-one",title:"One",backend:"vrm",modelPath:"m.vrm",sourceSha256:"hash",mappings,animations:catalog,vrm:{animations:[{name:"Idle",path:"a.vrma"}],profilePath:"p.json"}};
const installed:DesktopSettings = {...initial,models:[model],activeModelId:model.id};
const tick = () => new Promise(resolve => setTimeout(resolve,0));
const choose = (path:string) => {open.mockResolvedValueOnce(path);document.getElementById("choose-model")!.click();return tick();};
const importButton = () => document.getElementById("import-model") as HTMLButtonElement;
const importIdle = () => document.querySelector('#import-mappings select[data-state="idle"]') as HTMLSelectElement;
const inspected = {backend:"vrm",compatibilitySupported:true,animations:catalog,issues:[]};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Option",function(text:string,value:string){const option=document.createElement("option");option.textContent=text;option.value=value;return option;});
  document.body.innerHTML=readFileSync(resolve(import.meta.dirname,"../index.html"),"utf8").replace(/<script[\s\S]*?<\/script>/gu,"");
  invoke.mockResolvedValue(initial);
});
it("maps local VRM assets and rejects missing or disabled model backends before mounting", () => {
  expect(modelConfig(installed)).toMatchObject({backend:"vrm",model:"asset:m.vrm",animations:[{name:"Idle",url:"asset:a.vrma"}],profile:"asset:p.json",ambient:{animations:["Idle"]},render:{viewportPadding:{left:128,top:64,right:128,bottom:192}},camera:{pitchDegrees:5,targetHeight:.54},gaze:{maxYawDegrees:25,maxPitchDegrees:15}});
  const tracks=[{name:"Idle",timestepMs:10,length:10,leadIn:0,leadOut:0,weight:1,lanes:[]}];
  expect(() => modelConfig({...installed,models:[{...model,backend:"inochi2d",inochi2d:{animations:tracks}}]})).toThrow("Inochi2D is disabled");
  expect(() => modelConfig({...installed,activeModelId:null})).toThrow();
  expect(modelConfig({...installed,models:[{...model,mappings:{...mappings,idle:"Rest"}}]}).ambient).toEqual({animations:["Rest"]});
});
it("keeps explicit manual import separate from saved preferences and requires Idle", async () => {
  await startSettings();
  document.getElementById("add-model")!.click();
  invoke.mockResolvedValue(inspected);
  await choose("C:/models/pet.vrm");
  expect(importButton().disabled).toBe(true);
  open.mockResolvedValueOnce(["C:/motions/Idle.vrma"]);document.getElementById("choose-animations")!.click();await tick();
  open.mockResolvedValueOnce("C:/profile.json");document.getElementById("choose-profile")!.click();await tick();
  importIdle().value="Idle";importIdle().dispatchEvent(new Event("change",{bubbles:true}));
  expect(importButton().disabled).toBe(false);
  expect(invoke.mock.calls.some(([command]) => command==="install_model")).toBe(false);
  invoke.mockResolvedValue(installed);
  importButton().click();await tick();
  expect(invoke).toHaveBeenCalledWith("install_model",{request:expect.objectContaining({backend:"vrm",sourcePath:"C:/models/pet.vrm",animationSources:[{name:"Idle",path:"C:/motions/Idle.vrma"}],profilePath:"C:/profile.json",mappings:expect.objectContaining({idle:"Idle"}),preferences})});
  expect((document.getElementById("add-model-dialog") as HTMLDialogElement).open).toBe(false);
  expect(document.querySelector('[data-model-id="model-one"]')).not.toBeNull();
  expect(document.getElementById("save-settings")).toBeNull();
});
it("ignores stale inspection responses after selecting another file", async () => {
  await startSettings();let resolveOld!:(v:unknown)=>void;
  invoke.mockImplementationOnce(() => new Promise(resolve => {resolveOld=resolve;}));await choose("old.vrm");
  invoke.mockResolvedValueOnce({...inspected,animations:[]});await choose("new.vrm");
  resolveOld({backend:"inochi2d",compatibilitySupported:true,animations:catalog,issues:[]});await tick();
  expect(document.getElementById("model-path")!.textContent).toBe("new.vrm");
  expect(document.querySelectorAll('#import-mappings select[data-state="idle"] option')).toHaveLength(1);
  expect(importButton().disabled).toBe(true);
});
it("leaves existing models and preferences intact after failed inspection", async () => {
  invoke.mockResolvedValue(installed);await startSettings();
  invoke.mockRejectedValueOnce(new Error("invalid model"));await choose("new.vrm");
  importButton().click();await tick();
  expect((document.getElementById("fps") as HTMLSelectElement).value).toBe("60");
  expect(document.querySelector('[data-model-id="model-one"]')).not.toBeNull();
  expect(invoke.mock.calls.some(([command]) => command==="install_model")).toBe(false);
  expect(document.getElementById("import-error")!.textContent).toContain("invalid model");
});
it("rejects Inochi2D even when returned by the file picker", async () => {
  await startSettings();await choose("old.inp");
  expect(document.getElementById("import-error")!.textContent).toContain("本版本暂不支持 Inochi2D");
  expect(invoke.mock.calls.some(([command]) => command==="inspect_model")).toBe(false);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({filters:[{name:"VRM",extensions:["vrm"]}]}));
});
it("previews embedded model license before manual import", async () => {
  await startSettings();
  invoke.mockResolvedValue({...inspected,license:{title:"Model terms",text:"# Terms\n\nPersonal use."}});
  await choose("pet.vrm");
  const license=document.getElementById("view-import-license") as HTMLButtonElement;
  expect(license.hidden).toBe(false);license.click();
  expect(document.querySelector(".license-content h3")!.textContent).toBe("Terms");
  expect(invoke.mock.calls.some(([command]) => command==="install_model")).toBe(false);
});
