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
    let resolve:(value:PetInteraction)=>void=()=>{};const read=vi.fn(()=>new Promise<PetInteraction>(done=>{resolve=done}));const actions={read,answer:vi.fn(async()=>{}),open:vi.fn(async()=>{}),changed:vi.fn()};
    const element=document.createElement("output"),bubble=new WorkBubble(element,actions);bubble.update(snapshot,preferences);resolve(request);await vi.waitFor(()=>expect(element.querySelector("form")).not.toBeNull());
    const text=element.querySelector("textarea")!;text.value="草稿";text.dispatchEvent(new Event("input"));bubble.update({...snapshot,sequence:2},preferences);expect(element.querySelector("textarea")).toBe(text);expect(text.value).toBe("草稿");expect(read).toHaveBeenCalledOnce();
    bubble.update(snapshot,{...preferences,privacyMode:true});expect(element.querySelector("form")).toBeNull();expect(element.textContent).not.toContain("草稿");expect(element.dataset.interactive).toBeUndefined();
    bubble.update(snapshot,preferences);bubble.clear();resolve(request);await Promise.resolve();expect(element.hidden).toBe(true);expect(element.children).toHaveLength(0);
  });
  it("asks the Host to open the captured session",async()=>{
    const open=vi.fn(async(_ref:string)=>{});const element=document.createElement("output"),bubble=new WorkBubble(element,{read:async()=>request,answer:async()=>{},open,changed:()=>{}});
    bubble.update(snapshot,preferences);element.querySelector<HTMLButtonElement>("button")!.click();await vi.waitFor(()=>expect(open).toHaveBeenCalledExactlyOnceWith(ref));bubble.clear();
  });
  it("retains the pending form and selected answers after navigation fails and permits a successful retry",async()=>{
    let opened:()=>void=()=>{};
    const open=vi.fn<(_ref:string)=>Promise<void>>().mockRejectedValueOnce(Error("PRIVATE navigation detail")).mockImplementationOnce(()=>new Promise<void>(done=>{opened=done}));
    const actions={read:async()=>request,answer:vi.fn(async()=>{}),open,changed:vi.fn()};
    const element=document.createElement("output"),bubble=new WorkBubble(element,actions);bubble.update(snapshot,preferences);
    await vi.waitFor(()=>expect(element.querySelector("form")).not.toBeNull());
    const form=element.querySelector("form")!,single=form.querySelector<HTMLInputElement>('input[value="A"]')!,multi=form.querySelector<HTMLInputElement>('input[value="X"]')!,custom=form.querySelectorAll("textarea")[2]!;
    single.click();multi.click();custom.value="保留草稿";custom.dispatchEvent(new Event("input"));
    const submit=form.querySelector("button")!,transfer=[...element.querySelectorAll("button")].find(button=>button.textContent==="转到 DSH 回答")!;
    expect(submit.disabled).toBe(false);transfer.click();
    await vi.waitFor(()=>expect(transfer.disabled).toBe(false));
    expect(element.querySelector("form")).toBe(form);
    expect(single.checked).toBe(true);expect(multi.checked).toBe(true);expect(custom.value).toBe("保留草稿");expect(submit.disabled).toBe(false);
    const status=element.querySelector<HTMLElement>(".question-navigation-status")!;
    expect(status.textContent).toContain("继续在气泡中回答");expect(status.hidden).toBe(false);expect(element.textContent).not.toMatch(/浏览器|PRIVATE/);
    transfer.click();expect(transfer.disabled).toBe(true);expect(status.hidden).toBe(true);
    opened();await open.mock.results[1]!.value;await Promise.resolve();expect(status.hidden).toBe(true);
    expect(open).toHaveBeenNthCalledWith(1,ref);expect(open).toHaveBeenNthCalledWith(2,ref);expect(element.querySelector("form")).toBe(form);
    bubble.clear();
  });
  it.each(["resolve","reject"] as const)("ignores a previous question's late navigation %s",async outcome=>{
    let resolve:()=>void=()=>{},reject:(error:Error)=>void=()=>{};
    const opening=new Promise<void>((done,failed)=>{resolve=done;reject=failed});
    const nextId="123e4567-e89b-42d3-a456-426614174002",nextRequest={...request,requestId:nextId};
    const actions={read:async(requestId:string)=>requestId===id?request:nextRequest,answer:vi.fn(async()=>{}),open:vi.fn(()=>opening),changed:vi.fn()};
    const element=document.createElement("output"),bubble=new WorkBubble(element,actions);bubble.update(snapshot,preferences);
    await vi.waitFor(()=>expect(element.querySelector("form")).not.toBeNull());
    [...element.querySelectorAll("button")].find(button=>button.textContent==="转到 DSH 回答")!.click();
    bubble.update({...snapshot,inputRequest:nextId,sequence:2},preferences);
    await vi.waitFor(()=>expect(element.querySelector("form")).not.toBeNull());
    const form=element.querySelector("form")!,draft=form.querySelector("textarea")!;draft.value="新问题草稿";draft.dispatchEvent(new Event("input"));
    const updates=actions.changed.mock.calls.length;
    if(outcome==="resolve")resolve();else reject(Error("PRIVATE old navigation error"));
    await opening.catch(()=>{});await Promise.resolve();
    expect(actions.changed).toHaveBeenCalledTimes(updates);expect(element.querySelector("form")).toBe(form);expect(draft.value).toBe("新问题草稿");
    expect(element.querySelector<HTMLElement>(".question-navigation-status")!.hidden).toBe(true);expect(element.textContent).not.toMatch(/暂时无法|PRIVATE/);
    bubble.clear();
  });
});
