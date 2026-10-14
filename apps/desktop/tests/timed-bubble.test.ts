// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from "vitest";
import type {PetInteraction,PetSnapshot} from "@starcried/starlite-dsh-protocol";
import {WorkBubble} from "../src/work-bubble.js";

const requestId="123e4567-e89b-42d3-a456-426614174001",sessionRef="123e4567-e89b-42d3-a456-426614174000";
const request:PetInteraction={interactionVersion:1,requestId,sessionRef,questions:[{id:"q",question:"Choose",options:[{label:"A"}],multiSelect:false}]};
const snapshot:PetSnapshot={protocolVersion:1,sequence:1,emittedAt:1,state:"approval",session:{ref:sessionRef,title:"Current"},activity:"waiting",inputRequest:requestId};
const preferences={fps:60 as const,maxDevicePixelRatio:1.5,scale:1,privacyMode:false,bubbleMode:"compact" as const};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(read:()=>Promise<PetInteraction>){
  const element=document.createElement("output"),actions={read,answer:vi.fn(async()=>{}),open:vi.fn(async()=>{}),changed:vi.fn()};
  return {element,actions,bubble:new WorkBubble(element,actions)};
}
afterEach(()=>vi.useRealTimers());

describe("timed and continued question presentation",()=>{
  it("uses the Host deadline despite delayed reads and only updates presentation at expiry",async()=>{
    vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);
    let resolve!:(value:PetInteraction)=>void;
    const f=fixture(()=>new Promise(done=>{resolve=done;})),deadline=Date.now()+12_000;
    f.bubble.update(snapshot,preferences);await vi.advanceTimersByTimeAsync(2_000);
    resolve({...request,wait:{state:"timed",deadline}});await settle();
    const status=f.element.querySelector('[role="timer"]')!;
    expect(status.textContent).toContain("剩余 10 秒");expect(vi.getTimerCount()).toBe(1);
    const choice=f.element.querySelector<HTMLInputElement>("input")!,draft=f.element.querySelector("textarea")!;
    choice.click();draft.value="Draft";
    f.bubble.update({...snapshot,sequence:2},preferences);
    await vi.advanceTimersByTimeAsync(1_000);expect(status.textContent).toContain("剩余 9 秒");expect(choice.checked).toBe(true);expect(draft.value).toBe("Draft");
    await vi.advanceTimersByTimeAsync(9_000);expect(status.textContent).toBe("等待时间已结束，DSH 将继续处理。");
    expect(vi.getTimerCount()).toBe(0);expect(f.actions.answer).not.toHaveBeenCalled();expect(f.actions.open).not.toHaveBeenCalled();
    expect(f.element.querySelector("form")).not.toBeNull();f.bubble.clear();
  });
  it("labels a continued form without replacing actual work status or starting a countdown",async()=>{
    vi.useFakeTimers();const f=fixture(async()=>({...request,wait:{state:"continued"}}));
    f.bubble.update({...snapshot,state:"working",activity:"command"},preferences);await settle();
    expect(f.element.querySelector(".question-wait-status")?.textContent).toBe("DSH 已继续处理，仍可补答。");
    expect(f.element.querySelector("form")).not.toBeNull();expect(vi.getTimerCount()).toBe(0);expect(f.actions.answer).not.toHaveBeenCalled();f.bubble.clear();
  });
  it.each(["clear","privacy","switch"])("cleans up the countdown on %s and never updates the previous form",async reason=>{
    vi.useFakeTimers();const f=fixture(async()=>({...request,wait:{state:"timed",deadline:Date.now()+12_000}}));
    f.bubble.update(snapshot,preferences);await settle();expect(vi.getTimerCount()).toBe(1);
    if(reason==="clear")f.bubble.clear();
    else if(reason==="privacy")f.bubble.update(snapshot,{...preferences,privacyMode:true});
    else f.bubble.update({protocolVersion:1,sequence:2,emittedAt:1,session:snapshot.session!,state:"working",activity:"command"},preferences);
    const text=f.element.textContent,changed=f.actions.changed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.getTimerCount()).toBe(0);expect(f.element.textContent).toBe(text);expect(f.actions.changed).toHaveBeenCalledTimes(changed);f.bubble.clear();
  });
  it("does not create a timer for ordinary questions or a stale timed read",async()=>{
    vi.useFakeTimers();const f=fixture(async()=>request);f.bubble.update(snapshot,preferences);await settle();
    expect(f.element.querySelector(".question-wait-status")).toBeNull();expect(vi.getTimerCount()).toBe(0);f.bubble.clear();
    let resolve!:(value:PetInteraction)=>void;
    const late=fixture(()=>new Promise(done=>{resolve=done;}));late.bubble.update(snapshot,preferences);late.bubble.clear();
    resolve({...request,wait:{state:"timed",deadline:Date.now()+12_000}});await settle();
    expect(vi.getTimerCount()).toBe(0);expect(late.element.children).toHaveLength(0);
  });
});
