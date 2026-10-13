// @vitest-environment happy-dom
import {describe,it,expect,vi} from "vitest";
import {createQuestionForm} from "../src/question-form.js";
import {WorkBubble} from "../src/work-bubble.js";
import type {PetInteraction,PetSnapshot} from "@starcried/starlite-dsh-protocol";
const ref="123e4567-e89b-42d3-a456-426614174000",id="123e4567-e89b-42d3-a456-426614174001";
const request:PetInteraction={interactionVersion:1,requestId:id,sessionRef:ref,questions:[{id:"single",question:"<img>单选",options:[{label:"A"},{label:"B"}],multiSelect:false},{id:"multi",question:"多选",options:[{label:"X"},{label:"Y"}],multiSelect:true},{id:"text",question:"文字",options:[],multiSelect:false}]};
const snapshot:PetSnapshot={protocolVersion:1,sequence:1,emittedAt:1,state:"approval",session:{ref,title:"当前会话"},activity:"waiting",inputRequest:id};
const preferences={fps:60 as const,maxDevicePixelRatio:1.5,scale:1,privacyMode:false,bubbleMode:"compact" as const};
describe("ordinary question bubble",()=>{
  it("requires explicit complete answers, handles single/custom and multi/custom, and submits once",async()=>{
    let resolve:()=>void=()=>{};const submit=vi.fn(()=>new Promise<void>(done=>{resolve=done}));const form=createQuestionForm(request,submit);
    expect(form.querySelector("img")).toBeNull();const button=form.querySelector("button")!;expect(button.disabled).toBe(true);
    const groups=form.querySelectorAll("fieldset"),texts=form.querySelectorAll("textarea");
    groups[0]!.querySelector<HTMLInputElement>("input")!.click();texts[0]!.value="我的选择";texts[0]!.dispatchEvent(new Event("input"));expect(groups[0]!.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
    groups[1]!.querySelectorAll<HTMLInputElement>("input").forEach(input=>input.click());texts[1]!.value="补充";texts[1]!.dispatchEvent(new Event("input"));texts[2]!.value="回答";texts[2]!.dispatchEvent(new Event("input"));expect(button.disabled).toBe(false);
    form.dispatchEvent(new Event("submit",{cancelable:true}));form.dispatchEvent(new Event("submit",{cancelable:true}));
    expect(submit).toHaveBeenCalledExactlyOnceWith({requestId:id,sessionRef:ref,answers:[{id:"single",selected:[],custom:"我的选择"},{id:"multi",selected:["X","Y"],custom:"补充"},{id:"text",selected:[],custom:"回答"}]});
    resolve();await vi.waitFor(()=>expect(form.textContent).toContain("已提交"));expect(button.disabled).toBe(true);
  });
  it("keeps the draft through content updates and drops late replies after privacy/switch",async()=>{
    let resolve:(value:PetInteraction)=>void=()=>{};const read=vi.fn(()=>new Promise<PetInteraction>(done=>{resolve=done}));const actions={read,answer:vi.fn(async()=>{}),open:vi.fn(async()=>{}),delegate:vi.fn(async()=>{}),changed:vi.fn()};
    const element=document.createElement("output"),bubble=new WorkBubble(element,actions);bubble.update(snapshot,preferences);resolve(request);await vi.waitFor(()=>expect(element.querySelector("form")).not.toBeNull());
    const text=element.querySelector("textarea")!;text.value="草稿";text.dispatchEvent(new Event("input"));bubble.update({...snapshot,sequence:2},preferences);expect(element.querySelector("textarea")).toBe(text);expect(text.value).toBe("草稿");expect(read).toHaveBeenCalledOnce();
    bubble.update(snapshot,{...preferences,privacyMode:true});expect(element.querySelector("form")).toBeNull();expect(element.textContent).not.toContain("草稿");expect(element.dataset.interactive).toBeUndefined();
    bubble.update(snapshot,preferences);bubble.clear();resolve(request);await Promise.resolve();expect(element.hidden).toBe(true);expect(element.children).toHaveLength(0);
  });
  it("returns answering to DSH before opening the captured session",async()=>{
    const order:string[]=[];const element=document.createElement("output"),bubble=new WorkBubble(element,{read:async()=>request,answer:async()=>{},delegate:async()=>{order.push("delegate")},open:async value=>{order.push(value)},changed:()=>{}});
    bubble.update(snapshot,preferences);element.querySelector<HTMLButtonElement>("button")!.click();await vi.waitFor(()=>expect(order).toEqual(["delegate",ref]));bubble.clear();
  });
});
