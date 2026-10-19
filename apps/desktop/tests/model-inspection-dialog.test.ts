// @vitest-environment happy-dom
import {afterEach,expect,it} from "vitest";
import {showModelInspection} from "../src/model-inspection-dialog.js";
import type {ModelInspection} from "../src/types.js";
afterEach(() => {document.body.replaceChildren();});

function inspection(overrides: Partial<ModelInspection> = {}): ModelInspection {
  return {
    backend:"vrm", sourceSha256:"0".repeat(64), sourceBytes:1048576, compatibilitySupported:true,
    defaultMappings:{idle:"StarLiteIdle",working:null,completed:null,error:null,blocked:null,approval:null,click:[],ambient:[]},
    modelName:"测试角色", animations:[{name:"StarLiteIdle",durationMs:4000}], issues:[],
    capabilities:{humanoid:{requiredBones:["hips","head"],optionalBones:["leftEye","rightEye"]},blink:{automatic:true,combined:true,left:false,right:false},lookAt:{mode:"bone",head:true,eyes:true,horizontal:true,vertical:true}},
    metrics:{fileBytes:1048576,nodeCount:80,meshCount:4,primitiveCount:8,materialCount:6,textureCount:4,imageCount:4,vertexCount:73342,triangleCount:57291,morphTargetCount:264,decodedAccessorBytes:8388608},
    ...overrides,
  };
}

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

it("separates model features and resource counts without inventing an overall performance grade", () => {
  showModelInspection(inspection());
  const dialog = document.querySelector("dialog")!;
  const cards = [...dialog.querySelectorAll(".inspection-metric")];
  expect(cards).toHaveLength(3);
  expect(cards[0]!.textContent).toContain("57,291");
  expect(cards[0]!.querySelector(".inspection-badge")?.textContent).toBe("良好");
  expect(cards.slice(1).every(card=>!card.querySelector(".inspection-badge"))).toBe(true);
  expect([...dialog.querySelectorAll(".inspection-capability .inspection-badge")].map(node=>node.textContent)).toEqual(["已识别","可用","双轴可用"]);
  expect(dialog.querySelector("details")?.open).toBe(false);
  expect(dialog.textContent).toContain("材质数不等于材质槽");
  expect(dialog.textContent).toContain("不是 VRChat 的整体评级");
  expect(dialog.textContent).toContain("不等于 GPU 或进程内存");
  expect(dialog.querySelector(".inspection-advice")).toBeNull();
});

it.each([
  [0,"优秀","excellent"], [31999,"优秀","excellent"], [32000,"优秀","excellent"],
  [32001,"良好","good"], [70000,"良好","good"], [70001,"偏高","high"],
])("uses the inclusive PC triangle reference at %i without inventing intermediate limits", (triangles, label, tone) => {
  const report = inspection(); report.metrics!.triangleCount = triangles as number;
  showModelInspection(report);
  const card = document.querySelector(".inspection-metric")!;
  expect(card.querySelector(".inspection-number")?.textContent).toBe((triangles as number).toLocaleString("en-US"));
  expect(card.querySelector(".inspection-badge")?.textContent).toBe(label);
  expect(card.querySelector(".inspection-number")?.getAttribute("data-tone")).toBe(tone);
});

it("does not turn missing statistics or capabilities into a green zero score", () => {
  const report=inspection();delete report.metrics;delete report.capabilities;
  showModelInspection(report);
  expect(document.querySelector(".inspection-number")?.textContent).toBe("—");
  expect(document.querySelector(".inspection-metric .inspection-badge")).toBeNull();
  expect([...document.querySelectorAll(".inspection-capability .inspection-badge")].every(node=>node.textContent==="未提供检查结果"&&node.getAttribute("data-tone")==="neutral")).toBe(true);
});

it.each(["horizontal","vertical"] as const)("shows partial eye tracking and preserves actionable guidance (%s)", axis => {
  const report=inspection();report.capabilities!.lookAt[axis]=false;
  showModelInspection(report);
  const card=document.querySelectorAll(".inspection-capability")[2]!;
  expect(card.querySelector(".inspection-badge")?.textContent).toBe("部分可用");
  expect(card.querySelector(".inspection-badge")?.getAttribute("data-tone")).toBe("warning");
  expect(document.querySelector(".inspection-advice")?.textContent).toContain("水平、垂直角度范围");
});

it("keeps unsafe model names and error messages literal, and reports incompatible status in words", () => {
  showModelInspection(inspection({modelName:"<img src=x onerror=alert(1)>",compatibilitySupported:false,issues:[{code:"invalid",severity:"error",message:"<script>unsafe()</script>"}]}));
  const dialog=document.querySelector("dialog")!;
  expect(dialog.querySelector("img,script")).toBeNull();
  expect(dialog.querySelector("h2")?.textContent).toContain("<img src=x");
  expect(dialog.querySelector(".inspection-advice li")?.textContent).toBe("<script>unsafe()</script>");
  expect(dialog.querySelector(".inspection-subtitle .inspection-badge")?.textContent).toBe("需要检查");
  dialog.dispatchEvent(new Event("close"));
  expect(document.querySelector("dialog")).toBeNull();
});
