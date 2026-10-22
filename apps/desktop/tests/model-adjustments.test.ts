// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi, type Mock} from "vitest";
import {ModelAdjustmentsPanel} from "../src/model-adjustments.js";
import type {LibraryModel, ModelInspection, ModelAdjustments} from "../src/types.js";

const model: LibraryModel = {id:"first",title:"First",backend:"vrm",modelPath:"first/model.vrm",sourceSha256:"hash",animations:[{name:"StarLiteIdle",durationMs:6000}],mappings:{idle:"StarLiteIdle",working:null,completed:null,error:null,blocked:null,approval:null,click:[],ambient:[]},vrm:{animations:[]}};
const report: ModelInspection = {backend:"vrm",sourceSha256:"hash",sourceBytes:1024,animations:model.animations,defaultMappings:model.mappings,compatibilitySupported:true,issues:[],capabilities:{humanoid:{requiredBones:["head"],optionalBones:["leftIndexProximal"]},blink:{automatic:false,combined:false,left:false,right:false},lookAt:{mode:"none",head:true,eyes:false,horizontal:false,vertical:false}}};
let host: HTMLElement;
let panel: ModelAdjustmentsPanel;
let inspect: Mock<(model: LibraryModel) => Promise<ModelInspection>>;
let preview: Mock<(modelId: string, adjustments: ModelAdjustments) => void>;
let persist: Mock<(modelId: string, adjustments: ModelAdjustments) => Promise<unknown>>;
const field = (name: string) => document.getElementById("adjust-" + name) as HTMLInputElement;
const edit = (name: string, value: number, type = "input") => {const input=field(name);input.value=String(value);input.dispatchEvent(new Event(type));};
const open = async () => {const details=document.getElementById("model-adjustments") as HTMLDetailsElement;details.open=true;details.dispatchEvent(new Event("toggle"));await Promise.resolve();await Promise.resolve();};

beforeEach(() => {
  vi.useFakeTimers();document.body.innerHTML="<section></section>";host=document.querySelector("section")!;
  inspect=vi.fn(async () => structuredClone(report));preview=vi.fn();persist=vi.fn(async () => undefined);
  panel=new ModelAdjustmentsPanel(host,inspect,preview,persist);panel.update(structuredClone(model));
});
afterEach(() => {panel.destroy();vi.useRealTimers();});

it("checks optional capabilities lazily and keeps missing eyes disabled", async () => {
  expect(inspect).not.toHaveBeenCalled();expect(field("armLiftDegrees").disabled).toBe(true);
  await open();expect(inspect).toHaveBeenCalledOnce();
  expect(field("armLiftDegrees").disabled).toBe(false);expect(field("eyeStrength").disabled).toBe(true);
  expect(host.textContent).toContain("未配置有效眼球骨骼或视线表情");
  expect(field("handCurl").disabled).toBe(false);expect(host.textContent).toContain("仅调整已映射的手指");
  expect(field("handCurl").previousElementSibling?.textContent).toBe("原动作");
  const details=document.getElementById("model-adjustments") as HTMLDetailsElement;details.open=false;await open();expect(inspect).toHaveBeenCalledOnce();
});

it("previews each input immediately, debounces writes and flushes the final change", async () => {
  await open();edit("armLiftDegrees",10);edit("armLiftDegrees",12);
  expect(preview).toHaveBeenLastCalledWith("first",{idle:{armLiftDegrees:12}});expect(persist).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(199);expect(persist).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(persist).toHaveBeenCalledExactlyOnceWith("first",{idle:{armLiftDegrees:12}});
  edit("headStrength",.7);edit("headStrength",.8,"change");
  expect(persist).toHaveBeenLastCalledWith("first",{idle:{armLiftDegrees:12},gaze:{headStrength:.8}});
  await vi.advanceTimersByTimeAsync(250);expect(persist).toHaveBeenCalledTimes(2);
});

it("flushes the outgoing model before switching and never shares its values", async () => {
  await open();edit("armLiftDegrees",15);
  panel.update({...structuredClone(model),id:"second",title:"Second",adjustments:{gaze:{headStrength:.5}}});
  expect(persist).toHaveBeenCalledExactlyOnceWith("first",{idle:{armLiftDegrees:15}});
  expect(field("armLiftDegrees").value).toBe("0");expect(field("headStrength").value).toBe("0.5");
  await open();edit("palmTwistDegrees",5,"change");
  expect(persist).toHaveBeenLastCalledWith("second",{gaze:{headStrength:.5},idle:{palmTwistDegrees:5}});
});

it("preserves authored Idle poses and disables unmapped fingers", async () => {
  inspect.mockResolvedValue({...structuredClone(report),capabilities:{...report.capabilities!,humanoid:{requiredBones:["head"],optionalBones:[]}}});
  panel.update({...structuredClone(model),mappings:{...model.mappings,idle:"AuthoredIdle"}});await open();
  expect(field("armLiftDegrees").disabled).toBe(true);expect(field("palmTwistDegrees").disabled).toBe(true);expect(field("handCurl").disabled).toBe(true);
  expect(field("headStrength").disabled).toBe(false);expect(host.textContent).toContain("保留原有姿态");
});

it("resets individual overrides or all values while retaining the original gesture by default", async () => {
  panel.update({...structuredClone(model),adjustments:{idle:{armLiftDegrees:10,handCurl:.7},gaze:{eyeStrength:.4}}});await open();
  host.querySelector<HTMLButtonElement>('[aria-label="还原手部张合"]')!.click();
  expect(preview).toHaveBeenLastCalledWith("first",{idle:{armLiftDegrees:10},gaze:{eyeStrength:.4}});
  host.querySelector<HTMLButtonElement>(".adjustments-reset")!.click();expect(preview).toHaveBeenLastCalledWith("first",{});expect(persist).toHaveBeenLastCalledWith("first",{});
});

it("reports failed persistence and restores the saved live values", async () => {
  panel.update({...structuredClone(model),adjustments:{idle:{armLiftDegrees:2}}});await open();
  persist.mockRejectedValueOnce(new Error("disk full"));edit("armLiftDegrees",14,"change");await Promise.resolve();await Promise.resolve();
  expect(field("armLiftDegrees").value).toBe("2");expect(preview).toHaveBeenLastCalledWith("first",{idle:{armLiftDegrees:2}});
  expect(host.textContent).toContain("调节未保存，已恢复保存的设置");
});

it("ignores late inspection results after changing models", async () => {
  let finish!:(report: ModelInspection)=>void;inspect.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  await open();panel.update({...structuredClone(model),id:"second",title:"Second"});await Promise.resolve();await Promise.resolve();
  finish({...report,capabilities:{...report.capabilities!,lookAt:{mode:"bone",head:true,eyes:true,horizontal:true,vertical:true}}});await Promise.resolve();await Promise.resolve();
  expect(host.querySelector(".adjustments-model")!.textContent).toBe("Second");expect(field("eyeStrength").disabled).toBe(true);
});
