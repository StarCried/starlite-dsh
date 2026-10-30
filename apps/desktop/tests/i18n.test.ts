// @vitest-environment happy-dom
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { EN, format, hostNotice, setUiLocale, t, translateTemplate } from "../src/i18n.js";
import { renderBubble } from "../src/work-bubble.js";
import { createQuestionForm } from "../src/question-form.js";
import { renderBillingBubble } from "../src/billing-bubble.js";
import { showModelInspection } from "../src/model-inspection-dialog.js";
import { showModelImportHelp } from "../src/model-import-dialog.js";
import { exampleLicenseText } from "../src/example-license.js";
import type { PetSnapshot } from "../src/vendor-types.js";
import type { ModelInspection } from "../src/types.js";
import type { PetAnswer } from "@starcried/starlite-dsh-protocol";

afterEach(() => { setUiLocale("zh-CN"); document.body.replaceChildren(); });

it("resolves Chinese display-language variants and English fallback without translating parameters", () => {
  expect(setUiLocale("zh-TW")).toBe("zh-CN");
  expect(t("提交回答")).toBe("提交回答");
  expect(setUiLocale("en-US")).toBe("en");
  expect(format("移除「{title}」？", {title:"测试角色 <img src=x>"})).toBe("Remove “测试角色 <img src=x>”?");
  expect(setUiLocale("ja-JP")).toBe("en");
  expect(setUiLocale(undefined)).toBe("zh-CN");
});

it("translates the static settings template including accessibility labels", () => {
  setUiLocale("en");
  const html = readFileSync(resolve(import.meta.dirname,"../index.html"), "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script/u)![1]!;
  translateTemplate(document.body);
  expect(document.body.textContent).not.toMatch(/\p{Script=Han}/u);
  expect(document.querySelector("#model-library")?.getAttribute("aria-label")).toBe("Model library");
  expect(document.body.textContent).toContain("Changes are saved automatically");
});

it("covers every application-owned Chinese string literal in the frontend catalog", () => {
  const root = resolve(import.meta.dirname,"../src");
  const missing: string[] = [];
  for (const file of readdirSync(root).filter(file => file.endsWith(".ts") && file !== "i18n.ts")) {
    const source = readFileSync(resolve(root,file), "utf8");
    for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
      if (!/\p{Script=Han}/u.test(match[0])) continue;
      const value: string = JSON.parse(match[0]);
      if (!Object.hasOwn(EN,value)) missing.push(file+": "+value);
    }
  }
  expect(missing).toEqual([]);
});

it("localizes fixed work notices while preserving streamed text and session titles verbatim", () => {
  setUiLocale("en");
  const output=document.createElement("output");
  const snapshot:PetSnapshot={protocolVersion:1,sequence:1,emittedAt:1,state:"working",activity:"command",session:{ref:"123e4567-e89b-42d3-a456-426614174000",title:"工作中 <img src=x>"},bubble:{kind:"response",text:"正在使用 shell…"}};
  renderBubble(output,snapshot,false);
  expect(output.querySelector(".bubble-content")?.textContent).toBe("Running a command");
  expect(output.querySelector(".bubble-title")?.textContent).toBe(snapshot.session!.title);
  renderBubble(output,snapshot,false,"detailed");
  expect(output.querySelector(".bubble-content")?.textContent).toBe("正在使用 shell…");
  renderBubble(output,{...snapshot,bubble:{kind:"tool",text:"正在使用 shell…"}},false,"detailed");
  expect(output.querySelector(".bubble-content")?.textContent).toBe("Using shell…");
  expect(output.querySelector("img")).toBeNull();
  expect(hostNotice("任务已完成")).toBe("Task completed");
});

it("keeps question text and submitted answers intact while localizing form controls", async () => {
  setUiLocale("en");
  const submit=vi.fn(async(_answer:PetAnswer)=>{});
  const form=createQuestionForm({interactionVersion:1,requestId:"123e4567-e89b-42d3-a456-426614174001",sessionRef:"123e4567-e89b-42d3-a456-426614174000",questions:[{id:"q",question:"你的回答",options:[],multiSelect:false}]},submit);
  expect(form.querySelector("legend")?.textContent).toBe("你的回答");
  expect(form.querySelector("button")?.textContent).toBe("Submit answer");
  const input=form.querySelector("textarea")!;input.value="提交回答 <script>";input.dispatchEvent(new Event("input"));
  form.dispatchEvent(new Event("submit",{cancelable:true}));
  await vi.waitFor(()=>expect(form.textContent).toContain("Submitted"));
  expect(submit.mock.calls[0]?.[0]).toMatchObject({answers:[{id:"q",selected:[],custom:"提交回答 <script>"}]});
  expect(form.querySelector("script")).toBeNull();
});

it("renders English billing, inspection, and import help without a model request", () => {
  setUiLocale("en");
  const output=document.createElement("output");renderBillingBubble(output,{status:"loading"});
  expect(output.textContent).toContain("Loading balance and usage");
  expect(output.textContent).not.toMatch(/\p{Script=Han}/u);
  const report:ModelInspection={backend:"vrm",sourceSha256:"0".repeat(64),sourceBytes:1,compatibilitySupported:true,animations:[],issues:[],defaultMappings:{idle:"StarLiteIdle",working:null,completed:null,error:null,blocked:null,approval:null,click:[],ambient:[]}};
  showModelInspection(report);
  expect(document.querySelector("dialog")?.textContent).not.toMatch(/\p{Script=Han}/u);
  document.querySelector<HTMLDialogElement>("dialog")!.close();
  showModelImportHelp();
  expect(document.querySelector("dialog")?.textContent).toContain("Humanoid bones");
  expect(document.querySelector("dialog")?.textContent).not.toMatch(/\p{Script=Han}/u);
});

it("translates only exact known example terms, preserving arbitrary and updated licenses", () => {
  setUiLocale("en");
  const original=readFileSync(resolve(import.meta.dirname,"../../../docs/weiguang-license.md"),"utf8");
  expect(exampleLicenseText("weiguang-default",original)).toContain("Weiguang");
  expect(exampleLicenseText("custom",original)).toBe(original);
  expect(exampleLicenseText("weiguang-default",original+"\n更新条款")).toBe(original+"\n更新条款");
});
