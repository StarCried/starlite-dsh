// @vitest-environment happy-dom
import {afterEach,expect,it} from "vitest";
import {showModelInspection} from "../src/model-inspection-dialog.js";
import type {ModelInspection} from "../src/types.js";
afterEach(() => {document.body.replaceChildren();});

it("reports missing optional capabilities with instructions, uses plain text and closes cleanly", () => {
  const report: ModelInspection = {backend:"vrm",sourceSha256:"0".repeat(64),compatibilitySupported:true,defaultMappings:{idle:"StarLiteIdle",working:null,completed:null,error:null,blocked:null,approval:null,click:[],ambient:[]},modelName:"<img src=x onerror=alert(1)>",sourceBytes:1048576,animations:[{name:"StarLiteIdle",durationMs:4000}],issues:[],capabilities:{humanoid:{requiredBones:["hips"],optionalBones:[]},blink:{automatic:false,combined:false,left:false,right:false},lookAt:{mode:"none",head:true,eyes:false,horizontal:false,vertical:false}}};
  showModelInspection(report);
  const dialog=document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("绑定标准 Blink");
  expect(dialog.textContent).toContain("配置 VRM lookAt");
  expect(dialog.textContent).toContain("1.00 MiB");
  expect(dialog.textContent).toContain("<img src=x");expect(dialog.querySelector("img")).toBeNull();
  dialog.querySelector("button")!.click();
  dialog.dispatchEvent(new Event("close"));
  expect(document.querySelector("dialog")).toBeNull();
});
