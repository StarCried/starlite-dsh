// @vitest-environment happy-dom
import {beforeEach,expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {modelConfig} from "../src/renderer.js";
import {startSettings} from "../src/settings.js";
import type {DesktopSettings} from "../src/types.js";
const {invoke,open} = vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke,convertFileSrc:(path:string)=>`asset:${path}`}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open}));
const preferences = {fps:60 as const,maxDevicePixelRatio:1.5,scale:1,privacyMode:false,bubbleMode:"compact" as const};
const mappings = {idle:"Idle",working:null,blocked:null,approval:null,completed:null,error:null,click:[],ambient:[]};
const catalog = [{name:"Idle",durationMs:1000}];
const initial:DesktopSettings={schemaVersion:3,preferences};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const choose=(path:string)=>{open.mockResolvedValueOnce(path);document.getElementById("choose-model")!.click();return tick()};
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal("Option",function(text:string,value:string){const option=document.createElement("option");option.textContent=text;option.value=value;return option});document.body.innerHTML=readFileSync(resolve(import.meta.dirname,"../index.html"),"utf8").replace(/<script[\s\S]*?<\/script>/gu, "");invoke.mockResolvedValue(initial)});
it("keeps backend payloads separate and maps every local VRM asset",()=>{
 const settings:DesktopSettings={...initial,model:{backend:"vrm",modelPath:"m.vrm",sourceSha256:"hash",mappings,animations:catalog,vrm:{animations:[{name:"Idle",path:"a.vrma"}],profilePath:"p.json"}}};
 expect(modelConfig(settings)).toMatchObject({backend:"vrm",model:"asset:m.vrm",animations:[{name:"Idle",url:"asset:a.vrma"}],profile:"asset:p.json",ambient:{animations:["Idle"]},render:{viewportPadding:{left:128,top:64,right:128,bottom:192}},camera:{pitchDegrees:5,targetHeight:.54},gaze:{maxYawDegrees:25,maxPitchDegrees:15}});
 const tracks=[{name:"Idle",timestepMs:10,length:10,leadIn:0,leadOut:0,weight:1,lanes:[]}];
 expect(modelConfig({...settings,model:{...settings.model!,backend:"inochi2d",inochi2d:{animations:tracks}}}).animations).toEqual(tracks);
 expect(modelConfig({...settings,model:{...settings.model!,backend:"inochi2d",inochi2d:{animations:tracks}}}).render).not.toHaveProperty("viewportPadding");
 expect(modelConfig({...settings,model:{...settings.model!,mappings:{...mappings,idle:"Rest"}}}).ambient).toEqual({animations:["Rest"]});
});
it("requires explicit Idle and imports actions and profile with VRM defaults",async()=>{
 await startSettings();
 invoke.mockResolvedValue({backend:"vrm",compatibilitySupported:true,animations:catalog,issues:[]});
 await choose("C:/models/pet.vrm");
 expect((document.getElementById("fps") as HTMLSelectElement).value).toBe("30");
 const save=document.getElementById("save-settings") as HTMLButtonElement;
 expect(save.disabled).toBe(true);
 open.mockResolvedValueOnce(["C:/motions/Idle.vrma"]);document.getElementById("choose-animations")!.click();await tick();
 open.mockResolvedValueOnce("C:/profile.json");document.getElementById("choose-profile")!.click();await tick();
 const idle=document.querySelector('select[data-state="idle"]') as HTMLSelectElement;idle.value="Idle";idle.dispatchEvent(new Event("change",{bubbles:true}));
 expect(save.disabled).toBe(false);
 invoke.mockResolvedValue({...initial,model:{backend:"vrm",animations:catalog,mappings}});
 document.getElementById("settings-form")!.dispatchEvent(new Event("submit",{cancelable:true}));await tick();
 expect(invoke).toHaveBeenCalledWith("install_model",{request:expect.objectContaining({backend:"vrm",animationSources:[{name:"Idle",path:"C:/motions/Idle.vrma"}],profilePath:"C:/profile.json",preferences:expect.objectContaining({fps:30})})});
});
it("ignores an old inspection after choosing a different model",async()=>{
 await startSettings();let resolveOld!:(v:unknown)=>void;
 invoke.mockImplementationOnce(()=>new Promise(r=>{resolveOld=r}));await choose("old.inp");
 invoke.mockResolvedValueOnce({backend:"vrm",compatibilitySupported:true,animations:[],issues:[]});await choose("new.vrm");
 resolveOld({backend:"inochi2d",compatibilitySupported:true,animations:catalog,issues:[]});await tick();
 expect(document.getElementById("model-path")!.textContent).toBe("new.vrm");
 expect(document.querySelectorAll('select[data-state="idle"] option')).toHaveLength(1);
 expect((document.getElementById("save-settings") as HTMLButtonElement).disabled).toBe(true);
});
it("retains installed preferences and leaves failed replacement unsaved",async()=>{
 invoke.mockResolvedValueOnce({...initial,model:{backend:"inochi2d",modelPath:"old",animations:catalog,mappings}});
 await startSettings();invoke.mockRejectedValueOnce(new Error("invalid model"));await choose("new.vrm");
 expect((document.getElementById("fps") as HTMLSelectElement).value).toBe("60");
 document.getElementById("settings-form")!.dispatchEvent(new Event("submit"));await tick();
 expect(invoke.mock.calls.some(([name])=>name==="install_model")).toBe(false);
 expect(document.getElementById("settings-error")!.textContent).toContain("invalid model");
});
it("keeps existing random pools and saves checkbox edits without modifier keys",async()=>{
 const animations=[{name:"Idle"},{name:"Click_1"},{name:"Click_2"},{name:"Ambient_1"}];
 const installed={...initial,model:{backend:"vrm",modelPath:"m.vrm",sourceSha256:"hash",animations,mappings:{...mappings,click:["Click_1"],ambient:["Ambient_1"]},vrm:{animations:[]}}};
 invoke.mockResolvedValue(installed);
 await startSettings();
 const choice=(pool:string,name:string)=>document.querySelector(`[data-pool="${pool}"] input[value="${name}"]`) as HTMLInputElement;
 expect(choice("click","Click_1").checked).toBe(true);
 expect(choice("ambient","Ambient_1").checked).toBe(true);
 choice("click","Click_2").click();choice("ambient","Ambient_1").click();
 document.getElementById("settings-form")!.dispatchEvent(new Event("submit",{cancelable:true}));await tick();
 expect(invoke).toHaveBeenCalledWith("update_settings",{request:expect.objectContaining({mappings:expect.objectContaining({idle:"Idle",click:["Click_1","Click_2"],ambient:[]})})});
});
