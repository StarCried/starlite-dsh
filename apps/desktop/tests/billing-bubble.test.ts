// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { BillingSnapshot } from "@starcried/starlite-dsh-protocol";
import { BillingBubble, renderBillingBubble } from "../src/billing-bubble.js";
import { renderPlainBubble } from "../src/work-bubble.js";

const snapshot: BillingSnapshot = {
  billingVersion:1, checkedAt:1, balance:{status:"ready",balances:[{currency:"CNY",remaining:123.45}]},
  today:{date:"2026-10-08",timeZone:"Asia/Shanghai",partial:false,pricedRequests:1,unpricedRequests:0,
    pricingDate:"2026-10-08",estimates:[{currency:"CNY",minimum:.14,maximum:.28}]},
};
describe("click fee bubble", () => {
  it("shows currency/range and marks missing data without inventing zero spend", () => {
    const output=document.createElement("output");
    renderBillingBubble(output,{status:"ready",snapshot});
    expect(output.querySelector(".billing-balance")?.textContent).toBe("¥123.45CNY");
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("¥0.1400–0.2800");
    const partial = {...snapshot,balance:{status:"unavailable" as const,balances:[]},today:{...snapshot.today,partial:true,pricedRequests:0,unpricedRequests:2}};
    renderBillingBubble(output,{status:"ready",snapshot:partial});
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("暂不可用");
    expect(output.textContent).toContain("部分记录 · 2 次未计入");
    renderBillingBubble(output,{status:"ready",snapshot:{...partial,today:{...partial.today,partial:false}}});
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("暂不可用");
    renderBillingBubble(output,{status:"ready",snapshot:{...snapshot,balance:{status:"ready",balances:[{currency:"USD",remaining:10}]},today:{...snapshot.today,estimates:[{currency:"USD",minimum:.02,maximum:.04}]}}});
    expect(output.querySelector(".billing-balance")?.textContent).toBe("$10.00USD");
  });
  it("holds through same-state text, expires after ten seconds and restores the latest bubble", async () => {
    vi.useFakeTimers();
    const render = vi.fn(),restore = vi.fn();
    const bubble = new BillingBubble({read:async()=>snapshot,allowed:()=>true,render,restore});
    try {
      bubble.stateChanged("working"); await bubble.show(); bubble.stateChanged("working");
      expect(bubble.visible).toBe(true); expect(render).toHaveBeenLastCalledWith({status:"ready",snapshot});
      await vi.advanceTimersByTimeAsync(9999); expect(restore).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(bubble.visible).toBe(false); expect(restore).toHaveBeenCalledOnce();
    } finally {bubble.cancel();vi.useRealTimers();}
  });
  it("urgent state/disconnection cancels a pending response; late money never overwrites new work", async () => {
    let resolve: ((value:BillingSnapshot)=>void) | undefined;
    const render = vi.fn(),restore = vi.fn();
    const bubble = new BillingBubble({read:()=>new Promise(done=>{resolve=done;}),allowed:()=>true,render,restore});
    bubble.stateChanged("working"); const showing = bubble.show();
    expect(render).toHaveBeenCalledWith({status:"loading"});
    bubble.stateChanged("approval"); resolve?.(snapshot); await showing;
    expect(bubble.visible).toBe(false); expect(render).toHaveBeenCalledTimes(1); expect(restore).toHaveBeenCalledOnce();
    bubble.cancel();
  });
  it("privacy mode neither queries nor displays money, including a change during a query", async () => {
    let allowed = false; let resolve: ((value:BillingSnapshot)=>void) | undefined;
    const read = vi.fn(()=>new Promise<BillingSnapshot>(done=>{resolve=done;})); const render = vi.fn(),restore = vi.fn();
    const bubble = new BillingBubble({read,allowed:()=>allowed,render,restore});
    await bubble.show(); expect(read).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    allowed=true; const showing=bubble.show(); allowed=false; resolve?.(snapshot); await showing;
    expect(bubble.visible).toBe(false); expect(render).toHaveBeenCalledTimes(1); expect(restore).toHaveBeenCalledOnce();
  });
  it("latest click wins and errors remain short-lived without exposing their details", async () => {
    vi.useFakeTimers();
    const resolvers: ((value:BillingSnapshot)=>void)[]=[]; const render=vi.fn(),restore=vi.fn();
    const bubble=new BillingBubble({read:()=>new Promise(done=>resolvers.push(done)),allowed:()=>true,render,restore});
    try {
      const first=bubble.show(),second=bubble.show();
      resolvers[1]?.(snapshot); await second; resolvers[0]?.({...snapshot,balance:{status:"ready",balances:[{currency:"CNY",remaining:999}]}}); await first;
      expect(render).toHaveBeenLastCalledWith({status:"ready",snapshot});
      bubble.cancel();
      const failed=new BillingBubble({read:async()=>{throw new Error("PRIVATE token");},allowed:()=>true,render,restore});
      await failed.show(); expect(render).toHaveBeenLastCalledWith({status:"error"});
      await vi.advanceTimersByTimeAsync(10000); expect(failed.visible).toBe(false); failed.cancel();
    } finally {bubble.cancel();vi.useRealTimers();}
  });
});

describe("dedicated fee card", () => {
  it("separates the account balance, all-currency DSH estimates and current pricing period", () => {
    const output=document.createElement("output");
    const current:BillingSnapshot={...snapshot,pricingPeriod:"off-peak",balance:{...snapshot.balance,source:"deepseek-official",balances:[{currency:"USD",remaining:7.65},{currency:"CNY",remaining:123.45}]},today:{...snapshot.today,estimates:[...snapshot.today.estimates,{currency:"USD",minimum:.02,maximum:.04}]}};
    renderBillingBubble(output,{status:"ready",snapshot:current},"当前会话");
    expect(output.querySelector(".bubble-title")?.textContent).toBe("当前会话");
    expect(output.querySelector(".billing-balance")?.textContent).toBe("¥123.45CNY");
    expect(output.querySelector(".billing-secondary")?.textContent).toBe("USD $7.65");
    expect(output.querySelector(".billing-status")?.textContent).toBe("默认官方配置");
    expect(Array.from(output.querySelectorAll(".billing-estimate"),item=>item.textContent)).toEqual(["¥0.1400–0.2800","$0.0200–0.0400"]);
    expect(output.querySelector(".billing-period")?.textContent).toBe("当前空闲时段（半价）");
    expect(output.textContent).toContain("各官方模型用量区间估算 · 以账单为准");
    expect(output.querySelector(".bubble-content")).toBeNull();
  });

  it("states an unknown period explicitly and preserves incomplete-cost warnings", () => {
    const output=document.createElement("output");
    const partial:BillingSnapshot={...snapshot,balance:{status:"unavailable",balances:[]},today:{...snapshot.today,partial:true,pricedRequests:0,unpricedRequests:2}};
    renderBillingBubble(output,{status:"ready",snapshot:partial});
    expect(output.querySelector(".billing-message")?.textContent).toBe("暂时无法查询余额");
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("暂不可用");
    expect(output.textContent).toContain("部分记录 · 2 次未计入");
    expect(output.querySelector(".billing-period")?.textContent).toBe("当前计价时段待确认");
    expect(output.querySelector(".billing-timezone")?.textContent).toBe("北京时间");
    expect(output.textContent).not.toContain("高峰/空闲区间");
  });

  it("does not invent a cost for missing estimates and formats confirmed zero without a fake range", () => {
    const output=document.createElement("output");
    renderBillingBubble(output,{status:"ready",snapshot:{...snapshot,today:{...snapshot.today,estimates:[]}}});
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("暂不可用");
    renderBillingBubble(output,{status:"ready",snapshot:{...snapshot,today:{...snapshot.today,pricedRequests:0,estimates:[{currency:"CNY",minimum:0,maximum:0}]}}});
    expect(output.querySelector(".billing-estimate")?.textContent).toBe("¥0");
  });

  it("renders all states as text, permits card scrolling, and restores normal bubbles cleanly", () => {
    const output=document.createElement("output");
    output.dataset.interactive="true";output.dataset.bubbleMode="compact";output.hidden=true;
    const title='<img src=x onerror="alert(1)">';
    renderBillingBubble(output,{status:"loading"},title);
    expect(output.hidden).toBe(false);expect(output.dataset.interactive).toBe("true");expect(output.dataset.bubbleMode).toBeUndefined();
    expect(output.querySelector(".billing-card")?.getAttribute("aria-busy")).toBe("true");
    expect(output.querySelector(".bubble-title")?.textContent).toBe(title);expect(output.querySelector("img")).toBeNull();
    renderBillingBubble(output,{status:"ready",snapshot:{...snapshot,pricingPeriod:"peak",balance:{status:"unconfigured",balances:[]}}},title);
    expect(output.querySelectorAll(".billing-card")).toHaveLength(1);
    expect(output.textContent).toContain("请先配置官方 DeepSeek");
    expect(output.querySelector(".billing-period")?.textContent).toBe("当前高峰时段");
    renderBillingBubble(output,{status:"error"});
    expect(output.querySelector(".bubble-title")).toBeNull();
    expect(output.querySelector(".billing-card")?.getAttribute("aria-busy")).toBe("false");
    expect(output.textContent).toContain("费用暂时无法查询");
    expect(output.querySelector(".billing-amount")).toBeNull();
    renderPlainBubble(output,"运行命令","notice","新会话");
    expect(output.querySelector(".billing-card")).toBeNull();
    expect(output.querySelector(".bubble-content")?.textContent).toBe("运行命令");
    expect(output.dataset.interactive).toBeUndefined();
    expect(output.children).toHaveLength(2);expect(output.dataset.bubbleKind).toBe("notice");
  });
});
