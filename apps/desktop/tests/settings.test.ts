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
const path="C:\\Downloads\\character.vrm";
const terms={title:"测试角色",text:"# 模型许可\n\n仅供本地使用。<img src=x>"};
const preferences:DesktopPreferences={fps:60,maxDevicePixelRatio:1.2,scale:0.67,privacyMode:true,bubbleMode:"detailed",performanceOverlay:false};
const model:LibraryModel={id:"weiguang-default",title:"微光",backend:"vrm",modelPath:"C:\\models\\model.vrm",sourceSha256:"b".repeat(64),
 animations:[{name:"RelaxedBreath",durationMs:4000},{name:"Typing",durationMs:2000},{name:"HighWave",durationMs:3000}],
 mappings:{idle:"RelaxedBreath",working:"Typing",completed:null,error:null,blocked:null,approval:null,click:["HighWave"],ambient:[]},vrm:{animations:[]}};
const empty:DesktopSettings={schemaVersion:4,preferences,models:[],activeModelId:"weiguang-default"};
const installed:DesktopSettings={...empty,models:[model]};
const custom:LibraryModel={...model,id:"custom",title:"自定义角色"};
const button=() => document.querySelector<HTMLButtonElement>("#add-model")!;
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
  else if(command==="get_model_license")return terms;
  else if(command==="select_model")current={...current,activeModelId:args!.modelId!};
  else if(command==="remove_model"){
   current={...current,models:current.models.filter(item=>item.id!==args!.modelId),activeModelId:current.activeModelId===args!.modelId?null:current.activeModelId};
   return {settings:structuredClone(current)};
  }
  else if(command==="update_preferences")current={...current,preferences:args!.preferences!};
  else if(command==="update_model_mappings")current={...current,models:current.models.map(item => item.id===args!.modelId?{...item,mappings:args!.mappings!}:item)};
  else throw new Error("unexpected command: "+command);
  return structuredClone(current);
 });
 await startSettings();
}

function edit(id:string,value:string) {
 const field=document.getElementById(id) as HTMLInputElement;field.value=value;field.dispatchEvent(new Event("change",{bubbles:true}));return field;
}

describe("settings model library",() => {
 it.each([false,true])("rechecks installed motions without passing the program Idle as a user file (custom motion: %s)",async customMotion => {
  const external=customMotion?[{name:"Wave",path:"C:/models/wave.vrma"}]:[];
  const other:LibraryModel={...custom,modelPath:"C:/models/other.vrm",vrm:{animations:[{name:"StarLiteIdle",path:"C:/models/program-idle.vrma"},...external],profilePath:"C:/models/other-profile.json"}};
  const before:DesktopSettings={...installed,models:[model,other]};
  await launch(before);
  native.invoke.mockResolvedValueOnce({backend:"vrm",sourceSha256:"a".repeat(64),sourceBytes:1048576,modelName:"<img src=x>",animations:[{name:"StarLiteIdle",durationMs:4000}],defaultMappings:model.mappings,compatibilitySupported:true,issues:[],capabilities:{humanoid:{requiredBones:["hips","head"],optionalBones:[]},blink:{automatic:false,combined:false,left:false,right:false},lookAt:{mode:"none",head:true,eyes:false,horizontal:false,vertical:false}}});
  document.querySelector<HTMLButtonElement>('[aria-label="自定义角色的模型信息"]')!.click();
  await vi.waitFor(()=>expect(document.querySelector(".model-license-dialog[open]")).not.toBeNull());
  expect(native.invoke).toHaveBeenCalledWith("inspect_model",{path:other.modelPath,animationSources:external,profilePath:other.vrm!.profilePath});
  const dialog=document.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.textContent).toContain("自动眨眼：未配置");expect(dialog.textContent).toContain("1.00 MiB");
  expect(dialog.querySelector("img")).toBeNull();expect(dialog.textContent).toContain("<img src=x>");
  expect(current).toEqual(before);
  expect(native.invoke.mock.calls.some(([command])=>command==="select_model"||command==="install_model")).toBe(false);
  dialog.querySelector<HTMLButtonElement>("button")!.click();
  expect(document.querySelector("dialog")).toBeNull();
 });
 it("saves the performance overlay independently and reflects changes from another window",async () => {
  await launch();
  const field=document.getElementById("performance-overlay") as HTMLInputElement;
  expect(field.checked).toBe(false);
  field.checked=true;field.dispatchEvent(new Event("change",{bubbles:true}));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("update_preferences",{preferences:{...preferences,performanceOverlay:true}}));
  expect(current.preferences.scale).toBe(preferences.scale);
  const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
  callback({payload:{...structuredClone(current),preferences:{...current.preferences,performanceOverlay:false}}});
  expect(field.checked).toBe(false);
 });
 it("shows every model, switches by card and keeps add model last",async () => {
  await launch({...installed,models:[model,custom]});
  expect([...document.querySelectorAll(".model-choice[data-model-id] strong")].map(item => item.textContent)).toEqual(["微光","自定义角色"]);
  expect(document.querySelector("#model-library")!.lastElementChild!.contains(button())).toBe(true);
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
  await vi.waitFor(() => expect(document.querySelector(".model-license-dialog[open]")).not.toBeNull());
  expect(native.invoke).toHaveBeenCalledWith("get_model_license",{modelId:"custom"});
  expect(document.querySelector(".license-content h3")!.textContent).toBe("模型许可");
  expect(document.querySelector(".license-content")!.textContent).toContain("<img src=x>");
  expect(document.querySelector(".model-license-dialog img")).toBeNull();
  expect(native.invoke.mock.calls.some(([command]) => command==="select_model"||command==="install_model")).toBe(false);
 });
 it("prepares the default without an import picker or consent dialog",async () => {
  await launch(empty,installed);
  expect(native.open).not.toHaveBeenCalled();expect(document.querySelector(".model-license-dialog")).toBeNull();
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
  expect(document.querySelector("#settings-error")!.textContent).toBe("");
  expect(document.querySelector("#settings-status")!.textContent).toBe("已自动保存");
 });
 it("clears a failed default preparation after selecting and installing the default successfully",async()=>{
  await launch(empty,new Error("default download unavailable"));
  expect(document.querySelector("#settings-status")!.textContent).toBe("默认模型尚未就绪");
  native.invoke.mockImplementationOnce(async(command:string)=>{
   expect(command).toBe("select_model");current=structuredClone(installed);return structuredClone(current);
  });
  document.querySelector<HTMLButtonElement>('[data-model-id="weiguang-default"]')!.click();
  await vi.waitFor(()=>expect(activeIdle().value).toBe("RelaxedBreath"));
  expect(document.querySelector("#settings-error")!.textContent).toBe("");
  expect(document.querySelector("#settings-status")!.textContent).toBe("已自动保存");
 });
 it.each(["installed","opted out"])("refreshes failed preparation feedback when another window has %s",async resolution=>{
  await launch(empty,new Error("default download unavailable"));
  const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
  current=structuredClone(resolution==="installed"?installed:{...empty,activeModelId:null});callback({payload:structuredClone(current)});
  expect(document.getElementById("mapping-section")!.hidden).toBe(resolution!=="installed");
  expect(document.querySelector("#settings-error")!.textContent).toBe("");
  expect(document.querySelector("#settings-status")!.textContent).toBe("已自动保存");
 });
 it("keeps preparation failure when an external update still has no active installed model",async()=>{
  await launch(empty,new Error("default download unavailable"));
  const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
  callback({payload:{...empty,models:[custom]}});
  expect(document.querySelector("#settings-error")!.textContent).toBe("default download unavailable");
  expect(document.querySelector("#settings-status")!.textContent).toBe("默认模型尚未就绪");
 });
 it.each(["selection","external"])("keeps a separate failed preference when %s resolves default preparation",async resolution=>{
  await launch(empty,new Error("default download unavailable"));
  native.invoke.mockRejectedValueOnce(new Error("preference could not be saved"));edit("scale","0.75");
  await vi.waitFor(()=>expect(document.querySelector("#settings-error")!.textContent).toBe("preference could not be saved"));
  if(resolution==="selection"){
   native.invoke.mockImplementationOnce(async()=>{current=structuredClone(installed);return structuredClone(current);});
   document.querySelector<HTMLButtonElement>('[data-model-id="weiguang-default"]')!.click();
   await vi.waitFor(()=>expect(activeIdle().value).toBe("RelaxedBreath"));
  }else{
   const callback=(native.listen.mock.calls[0] as unknown as [string,(event:{payload:DesktopSettings})=>void])[1];
   current=structuredClone(installed);callback({payload:structuredClone(current)});
  }
  expect(document.querySelector("#settings-error")!.textContent).toBe("preference could not be saved");
  expect(document.querySelector("#settings-status")!.textContent).toBe("部分更改未保存");
  expect((document.getElementById("scale") as HTMLInputElement).value).toBe("0.75");
  expect(current.preferences.scale).toBe(preferences.scale);
 });
});

it("honors the last click even when it returns to the already active model",async () => {
 await launch({...installed,models:[model,custom]});
 document.querySelector<HTMLButtonElement>('[data-model-id="custom"]')!.click();
 document.querySelector<HTMLButtonElement>('[data-model-id="weiguang-default"]')!.click();
 await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("select_model",{modelId:"weiguang-default"}));
 expect(current.activeModelId).toBe("weiguang-default");
});
it("does not reintroduce an absent starter after removal or opting out",async () => {
 await launch({...empty,activeModelId:null});
 expect(document.querySelector('[data-model-id="weiguang-default"]')).toBeNull();
 expect(button().disabled).toBe(false);
});

it.each(["weiguang-default","custom"])("removes %s with explicit confirmation and preserves the other model",async id => {
 await launch({...installed,models:[model,custom],activeModelId:id});
 document.querySelector<HTMLButtonElement>('[aria-label="移除'+(id==="custom"?custom.title:model.title)+'"]')!.click();
 const dialog=document.querySelector<HTMLDialogElement>(".model-remove-dialog")!;
 expect(dialog.open).toBe(true);
 expect(dialog.textContent).toContain(id==="custom"?custom.title:model.title);
 expect(dialog.textContent).toContain("原始 VRM 文件保留");
 expect(native.invoke.mock.calls.some(([command])=>command==="remove_model")).toBe(false);
 [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.textContent==="移除")!.click();
 await vi.waitFor(()=>expect(current.models).toHaveLength(1));
 expect(current.models[0]!.id).not.toBe(id);expect(current.activeModelId).toBeNull();
 expect(document.querySelector('[data-model-id="'+id+'"]')).toBeNull();
 expect(document.getElementById("mapping-section")!.hidden).toBe(true);
 expect(document.getElementById("settings-status")!.textContent).toBe("模型已移除");
});

it("removes an inactive model without switching or remounting the active choice",async()=>{
 await launch({...installed,models:[model,custom]});
 document.querySelector<HTMLButtonElement>('[aria-label="移除自定义角色"]')!.click();
 document.querySelector<HTMLDialogElement>(".model-remove-dialog")!.close("remove");
 await vi.waitFor(()=>expect(current.models).toHaveLength(1));
 expect(current.activeModelId).toBe(model.id);expect(activeIdle().value).toBe("RelaxedBreath");
});

it("cancels removal without native writes, including closing the confirmation",async()=>{
 await launch();
 const remove=()=>document.querySelector<HTMLButtonElement>('[aria-label="移除微光"]')!.click();
 remove();document.querySelector<HTMLButtonElement>(".model-remove-dialog button")!.click();await tick();
 remove();document.querySelector<HTMLDialogElement>(".model-remove-dialog")!.close();await tick();
 expect(native.invoke.mock.calls.some(([command])=>command==="remove_model")).toBe(false);
 expect(current.models).toHaveLength(1);
});

it("keeps the last model and its selection when removal cannot be saved",async()=>{
 await launch();native.invoke.mockRejectedValueOnce(new Error("removal could not be saved"));
 document.querySelector<HTMLButtonElement>('[aria-label="移除微光"]')!.click();
 document.querySelector<HTMLDialogElement>(".model-remove-dialog")!.close("remove");
 await vi.waitFor(()=>expect(document.getElementById("settings-error")!.textContent).toContain("removal could not be saved"));
 expect(current.models).toHaveLength(1);expect(current.activeModelId).toBe(model.id);
});

it("reports cleanup failure as saved removal rather than claiming a failed setting write",async()=>{
 await launch();
 const removed={...installed,models:[],activeModelId:null};
 native.invoke.mockResolvedValueOnce({settings:removed,cleanupWarning:"模型已移除，但本机副本清理未完成；原始 VRM 文件未改变。"});
 document.querySelector<HTMLButtonElement>('[aria-label="移除微光"]')!.click();
 document.querySelector<HTMLDialogElement>(".model-remove-dialog")!.close("remove");
 await vi.waitFor(()=>expect(document.getElementById("settings-status")!.textContent).toContain("本机副本清理未完成"));
 expect(document.querySelector('[data-model-id="weiguang-default"]')).toBeNull();
 expect(document.getElementById("settings-error")!.textContent).toBe("");
 expect(document.getElementById("mapping-section")!.hidden).toBe(true);
});

it("allows cancelling a pending starter download without an installed model entry",async()=>{
 await launch(empty);
 document.querySelector<HTMLButtonElement>('[aria-label="移除微光"]')!.click();
 document.querySelector<HTMLDialogElement>(".model-remove-dialog")!.close("remove");
 await vi.waitFor(()=>expect(current.activeModelId).toBeNull());
 expect(current.models).toHaveLength(0);expect(document.querySelector('[data-model-id="weiguang-default"]')).toBeNull();
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

