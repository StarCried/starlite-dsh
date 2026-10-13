// @vitest-environment happy-dom
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {startSettings} from "../src/settings.js";
import type {AnimationMappings, DesktopPreferences, DesktopSettings, LibraryModel} from "../src/types.js";
const native=vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn(),listen:vi.fn(async () => () => {})}));
vi.mock("@tauri-apps/api/core",() => ({invoke:native.invoke}));
vi.mock("@tauri-apps/plugin-dialog",() => ({open:native.open}));
vi.mock("@tauri-apps/api/event",() => ({listen:native.listen}));
const page=readFileSync(resolve(import.meta.dirname,"../index.html"),"utf8").match(/<main id="settings-view"[\s\S]+?<\/main>/u)![0];
const path="C:\\Downloads\\character.zip";
const pack={title:"测试角色",license:"# 模型许可\n\n仅供本地使用。<img src=x>",sha256:"a".repeat(64),animationCount:3};
const preferences:DesktopPreferences={fps:60,maxDevicePixelRatio:1.2,scale:0.67,privacyMode:true,bubbleMode:"detailed"};
const model:LibraryModel={id:"weiguang-default",title:"微光",backend:"vrm",modelPath:"C:\\models\\model.vrm",sourceSha256:"b".repeat(64),
 animations:[{name:"RelaxedBreath",durationMs:4000},{name:"Typing",durationMs:2000},{name:"HighWave",durationMs:3000}],
 mappings:{idle:"RelaxedBreath",working:"Typing",completed:null,error:null,blocked:null,approval:null,click:["HighWave"],ambient:[]},vrm:{animations:[]}};
const empty:DesktopSettings={schemaVersion:4,preferences,models:[],activeModelId:"weiguang-default"};
const installed:DesktopSettings={...empty,models:[model]};
const custom:LibraryModel={...model,id:"custom",title:"自定义角色"};
const button=() => document.querySelector<HTMLButtonElement>("#import-resource-pack")!;
const accept=() => document.querySelector<HTMLButtonElement>(".resource-license .primary")!;
const activeIdle=() => document.querySelector<HTMLSelectElement>('#animation-mappings select[data-state="idle"]')!;
const tick=() => new Promise(resolve => setTimeout(resolve,0));
type NativeArgs={preferences?:DesktopPreferences;modelId?:string|null;mappings?:AnimationMappings};
let current:DesktopSettings;

beforeEach(() => {
 document.body.innerHTML=page;
 vi.stubGlobal("Option",function Option(text:string,value:string){const option=document.createElement("option");option.textContent=text;option.value=value;return option;});
 native.invoke.mockReset();native.open.mockReset().mockResolvedValue(path);native.listen.mockClear();
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

async function launch(initial:DesktopSettings=installed,prepared:DesktopSettings|Error=initial) {
 current=structuredClone(initial);
 native.invoke.mockImplementation(async (command:string,args?:NativeArgs) => {
  if(command==="get_settings")return structuredClone(current);
  if(command==="prepare_model"){if(prepared instanceof Error)throw prepared;current=structuredClone(prepared);}
  else if(command==="get_model_license")return {title:pack.title,text:pack.license};
  else if(command==="inspect_resource_pack")return pack;
  else if(command==="install_resource_pack")current={...current,preferences:args!.preferences!,models:[...current.models,custom],activeModelId:custom.id};
  else if(command==="select_model")current={...current,activeModelId:args!.modelId!};
  else if(command==="update_preferences")current={...current,preferences:args!.preferences!};
  else if(command==="update_model_mappings")current={...current,models:current.models.map(item => item.id===args!.modelId?{...item,mappings:args!.mappings!}:item)};
  else throw new Error("unexpected command: "+command);
  return structuredClone(current);
 });
 await startSettings();
}

async function inspect() {
 document.getElementById("add-model")!.click();button().click();
 await vi.waitFor(() => expect(document.querySelector(".resource-license[open]")).not.toBeNull());
}
function edit(id:string,value:string) {
 const field=document.getElementById(id) as HTMLInputElement;field.value=value;field.dispatchEvent(new Event("change",{bubbles:true}));return field;
}

describe("settings model library",() => {
 it("shows every model, switches by card and keeps add model last",async () => {
  await launch({...installed,models:[model,custom]});
  expect([...document.querySelectorAll(".model-choice strong")].map(item => item.textContent)).toEqual(["微光","自定义角色"]);
  expect(document.querySelector("#model-library")!.lastElementChild!.id).toBe("add-model");
  expect(document.getElementById("model-enabled")).toBeNull();expect(document.getElementById("save-settings")).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-model-id="custom"]')!.click();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("select_model",{modelId:"custom"}));
  await vi.waitFor(() => expect(document.querySelector('[data-model-id="custom"]')!.getAttribute("aria-pressed")).toBe("true"));
  expect(current.models).toHaveLength(2);
 });
 it("can opt out without deleting models or needing an Idle mapping",async () => {
  await launch();
  document.querySelector<HTMLButtonElement>(".model-none")!.click();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("select_model",{modelId:null}));
  await vi.waitFor(() => expect(document.getElementById("mapping-section")!.hidden).toBe(true));
  expect(current.models).toHaveLength(1);expect(current.activeModelId).toBeNull();
 });
 it("opens the selected card's formatted license without selecting or importing it",async () => {
  await launch({...installed,models:[model,custom]});
  document.querySelector<HTMLButtonElement>('[aria-label="自定义角色的许可"]')!.click();
  await vi.waitFor(() => expect(document.querySelector(".resource-license[open]")).not.toBeNull());
  expect(native.invoke).toHaveBeenCalledWith("get_model_license",{modelId:"custom"});
  expect(document.querySelector(".license-content h3")!.textContent).toBe("模型许可");
  expect(document.querySelector(".license-content")!.textContent).toContain("<img src=x>");
  expect(document.querySelector(".resource-license img")).toBeNull();
  expect(native.invoke.mock.calls.some(([command]) => command==="select_model"||command==="install_resource_pack")).toBe(false);
 });
 it("prepares the default without an import picker or consent dialog",async () => {
  await launch(empty,installed);
  expect(native.open).not.toHaveBeenCalled();expect(document.querySelector(".resource-license")).toBeNull();
  expect(activeIdle().value).toBe("RelaxedBreath");
  expect(native.invoke.mock.calls.map(([command])=>command)).toEqual(["get_settings","prepare_model"]);
  expect(document.body.textContent).not.toContain("（进阶）");
  expect(document.body.textContent).not.toContain("无需额外配置");
 });
 it("still permits manual import and opting out when default preparation fails",async () => {
  await launch(empty,new Error("character unavailable"));
  expect(document.querySelector("#settings-error")!.textContent).toContain("character unavailable");
  expect(button().disabled).toBe(false);
  document.querySelector<HTMLButtonElement>(".model-none")!.click();
  await vi.waitFor(() => expect(current.activeModelId).toBeNull());
 });
});

it("honors the last click even when it returns to the already active model",async () => {
 await launch({...installed,models:[model,custom]});
 document.querySelector<HTMLButtonElement>('[data-model-id="custom"]')!.click();
 document.querySelector<HTMLButtonElement>('[data-model-id="weiguang-default"]')!.click();
 await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("select_model",{modelId:"weiguang-default"}));
 expect(current.activeModelId).toBe("weiguang-default");
});
it("keeps uncached default model selectable while opted out",async () => {
 await launch({...empty,activeModelId:null});
 expect(document.querySelector('[data-model-id="weiguang-default"]')!.textContent).toContain("待下载");
 document.querySelector<HTMLButtonElement>('[data-model-id="weiguang-default"]')!.click();
 await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("select_model",{modelId:"weiguang-default"}));
 await vi.waitFor(() => expect(document.getElementById("settings-status")!.textContent).toContain("重启 DSH"));
});
it("preserves legacy models without advertising disabled Inochi2D as VRM",async () => {
 await launch({...installed,models:[model,{...custom,backend:"inochi2d"}]});
 const card=document.querySelector<HTMLButtonElement>('[data-model-id="custom"]')!;
 expect(card.disabled).toBe(true);expect(card.textContent).toContain("Inochi2D · 本版本暂不支持");
});

describe("automatic settings persistence",() => {
 it("coalesces fast preference edits and preserves focused fields",async () => {
  await launch();
  const scale=edit("scale","0.75");scale.focus();edit("dpr","1.1");edit("fps","30");
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("update_preferences",{preferences:{...preferences,scale:.75,maxDevicePixelRatio:1.1,fps:30}}));
  expect(native.invoke.mock.calls.filter(([command]) => command==="update_preferences")).toHaveLength(1);
  expect(document.activeElement).toBe(scale);
  expect(document.querySelector("#settings-status")!.textContent).toBe("已自动保存");
 });
 it("keeps the newest preference edits when an earlier write is slow",async () => {
  await launch();let release!:(value:DesktopSettings)=>void;
  native.invoke.mockImplementationOnce(() => new Promise<DesktopSettings>(resolve => {release=resolve;}));
  edit("scale","0.75");await tick();edit("scale","0.8");edit("dpr","1.1");
  release({...installed,preferences:{...preferences,scale:.75}});
  await vi.waitFor(() => expect(current.preferences.scale).toBe(.8));
  expect(current.preferences.maxDevicePixelRatio).toBe(1.1);
  expect((document.getElementById("scale") as HTMLInputElement).value).toBe("0.8");
 });
 it("shows failed persistence without claiming that changes saved",async () => {
  await launch();native.invoke.mockRejectedValueOnce(new Error("disk full"));edit("scale","0.75");
  await vi.waitFor(() => expect(document.getElementById("settings-error")!.textContent).toContain("disk full"));
  expect(document.getElementById("settings-status")!.textContent).toBe("更改未保存");
  expect(current.preferences.scale).toBe(.67);
 });
 it("validates preferences before native writes",async () => {
  await launch();edit("dpr","9");
  expect(document.getElementById("settings-error")!.textContent).toContain("DPR");
  expect(native.invoke.mock.calls.some(([command]) => command==="update_preferences")).toBe(false);
 });
 it("autosaves animation pools to the correct model while switching",async () => {
  await launch({...installed,models:[model,custom]});
  const choice=document.querySelector<HTMLInputElement>('#animation-mappings [data-pool="click"] input[value="Typing"]')!;
  choice.focus();choice.click();
  document.querySelector<HTMLButtonElement>('[data-model-id="custom"]')!.click();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("update_model_mappings",{modelId:model.id,mappings:{...model.mappings,click:["Typing","HighWave"]}}));
  await vi.waitFor(() => expect(current.activeModelId).toBe("custom"));
  expect(current.models.find(item=>item.id===model.id)!.mappings.click).toEqual(["Typing","HighWave"]);
  expect(current.models.find(item=>item.id==="custom")!.mappings.click).toEqual(["HighWave"]);
 });
 it("does not let delayed default preparation erase a newer opt-out or preference",async () => {
  let prepared!:(value:DesktopSettings)=>void;
  current=structuredClone(empty);
  native.invoke.mockImplementation(async(command:string,args?:NativeArgs) => {
   if(command==="get_settings")return structuredClone(empty);
   if(command==="prepare_model")return new Promise<DesktopSettings>(resolve=>{prepared=resolve;});
   if(command==="select_model"){current={...current,activeModelId:args!.modelId!};return structuredClone(current);}
   if(command==="update_preferences"){current={...current,preferences:args!.preferences!};return structuredClone(current);}
   throw new Error(command);
  });
  const started=startSettings();
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("prepare_model"));
  document.querySelector<HTMLButtonElement>(".model-none")!.click();edit("scale","0.9");
  current=structuredClone(installed);prepared(structuredClone(installed));await started;
  await vi.waitFor(() => expect(current.activeModelId).toBeNull());
  await vi.waitFor(() => expect(current.preferences.scale).toBe(.9));
  expect(document.querySelector<HTMLButtonElement>(".model-none")!.getAttribute("aria-pressed")).toBe("true");
  expect((document.getElementById("scale") as HTMLInputElement).value).toBe("0.9");
 });
});

it("receives tray privacy changes without overwriting them on the next FPS edit",async () => {
 await launch({...installed,preferences:{...preferences,privacyMode:false}});
 const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
 current={...current,preferences:{...current.preferences,privacyMode:true}};callback({payload:structuredClone(current)});
 expect((document.getElementById("privacy") as HTMLInputElement).checked).toBe(true);
 edit("fps","30");await vi.waitFor(() => expect(current.preferences.fps).toBe(30));
 expect(current.preferences.privacyMode).toBe(true);
});
it("merges external privacy changes with queued local edits",async () => {
 await launch({...installed,preferences:{...preferences,privacyMode:false}});
 let release!:(value:DesktopSettings)=>void;
 native.invoke.mockImplementationOnce(() => new Promise<DesktopSettings>(resolve=>{release=resolve;}));
 document.querySelector<HTMLButtonElement>(".model-none")!.click();await tick();edit("fps","30");
 const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
 current={...current,preferences:{...current.preferences,privacyMode:true}};callback({payload:structuredClone(current)});
 release({...current,activeModelId:null});await vi.waitFor(() => expect(current.preferences.fps).toBe(30));
 expect(current.preferences.privacyMode).toBe(true);
});
it("restores an invalid Idle instead of leaving an unsaved blank field",async () => {
 await launch();const idle=activeIdle();idle.value="";idle.dispatchEvent(new Event("change",{bubbles:true}));
 expect(activeIdle().value).toBe("RelaxedBreath");
 expect(native.invoke.mock.calls.some(([command])=>command==="update_model_mappings")).toBe(false);
 expect(document.getElementById("settings-error")!.textContent).toContain("待机动画必须选择");
});

describe("resource package import",() => {
 it("requires formatted license consent, appends the model and activates authored mappings",async () => {
  await launch();await inspect();
  expect(native.invoke.mock.calls.some(([command]) => command==="install_resource_pack")).toBe(false);
  accept().click();
  await vi.waitFor(() => expect(document.getElementById("settings-status")!.textContent).toBe("模型已添加并启用"));
  expect(native.invoke).toHaveBeenCalledWith("install_resource_pack",{path,expectedSha256:pack.sha256,acceptLicense:true,preferences});
  expect(current.models).toHaveLength(2);expect(current.activeModelId).toBe("custom");
  expect(activeIdle().value).toBe("RelaxedBreath");
  expect(document.querySelector(".resource-license")).toBeNull();
  expect((document.getElementById("add-model-dialog") as HTMLDialogElement).open).toBe(false);
 });
 it("cancelling the picker or license preserves the library",async () => {
  await launch();native.open.mockResolvedValueOnce(null);button().click();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  await inspect();document.querySelector(".resource-license")!.dispatchEvent(new Event("cancel",{cancelable:true}));
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  expect(current.models).toHaveLength(1);expect(activeIdle().value).toBe("RelaxedBreath");
  expect(native.invoke.mock.calls.some(([command]) => command==="install_resource_pack")).toBe(false);
 });
 it("retains the library after a damaged package and restores import controls",async () => {
  await launch();native.invoke.mockRejectedValueOnce(new Error("SHA-256 mismatch"));button().click();
  await vi.waitFor(() => expect(document.getElementById("import-error")!.textContent).toContain("SHA-256 mismatch"));
  expect(current.models).toHaveLength(1);expect(button().disabled).toBe(false);
  await inspect();native.invoke.mockRejectedValueOnce(new Error("package changed"));accept().click();
  await vi.waitFor(() => expect(document.getElementById("import-error")!.textContent).toContain("package changed"));
  expect(current.models).toHaveLength(1);expect(button().disabled).toBe(false);
 });
 it("blocks duplicate pickers and Escape while an import is in flight",async () => {
  await launch();document.getElementById("add-model")!.click();let choose!:(value:null)=>void;
  native.open.mockImplementationOnce(() => new Promise(resolve=>{choose=resolve;}));
  button().click();button().click();expect(native.open).toHaveBeenCalledOnce();
  const event=new Event("cancel",{cancelable:true});document.getElementById("add-model-dialog")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);choose(null);
  await vi.waitFor(() => expect(button().disabled).toBe(false));
 });
});
