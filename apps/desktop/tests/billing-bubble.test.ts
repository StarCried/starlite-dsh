import { describe, expect, it, vi } from "vitest";
import type { BillingSnapshot } from "@dsh-inochi2d-pet/protocol";
import { BillingBubble, formatBilling } from "../src/billing-bubble.js";

const snapshot: BillingSnapshot = {
  billingVersion:1, checkedAt:1, balance:{status:"ready",balances:[{currency:"CNY",remaining:123.45}]},
  today:{date:"2026-10-08",timeZone:"Asia/Shanghai",partial:false,pricedRequests:1,unpricedRequests:0,
    pricingDate:"2026-10-08",estimates:[{currency:"CNY",minimum:.14,maximum:.28}]},
};
describe("click fee bubble", () => {
  it("shows currency/range and marks missing data without inventing zero spend", () => {
    expect(formatBilling(snapshot)).toContain("余额 ¥123.45\n今日 DSH 估算 ¥0.1400–0.2800");
    const partial = {...snapshot,balance:{status:"unavailable" as const,balances:[]},today:{...snapshot.today,partial:true,pricedRequests:0,unpricedRequests:2}};
    expect(formatBilling(partial)).toContain("今日 DSH 估算 暂不可用");
    expect(formatBilling(partial)).toContain("部分记录 · 2 次未计入");
    expect(formatBilling({...partial,today:{...partial.today,partial:false}})).toContain("暂不可用");
    expect(formatBilling({...snapshot,balance:{status:"ready",balances:[{currency:"USD",remaining:10}]},today:{...snapshot.today,estimates:[{currency:"USD",minimum:.02,maximum:.04}]}})).toContain("$10.00");
  });
  it("holds through same-state text, expires after ten seconds and restores the latest bubble", async () => {
    vi.useFakeTimers();
    const render = vi.fn(),restore = vi.fn();
    const bubble = new BillingBubble({read:async()=>snapshot,allowed:()=>true,render,restore});
    try {
      bubble.stateChanged("working"); await bubble.show(); bubble.stateChanged("working");
      expect(bubble.visible).toBe(true); expect(render).toHaveBeenLastCalledWith(formatBilling(snapshot));
      await vi.advanceTimersByTimeAsync(9999); expect(restore).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(bubble.visible).toBe(false); expect(restore).toHaveBeenCalledOnce();
    } finally {bubble.cancel();vi.useRealTimers();}
  });
  it("urgent state/disconnection cancels a pending response; late money never overwrites new work", async () => {
    let resolve: ((value:BillingSnapshot)=>void) | undefined;
    const render = vi.fn(),restore = vi.fn();
    const bubble = new BillingBubble({read:()=>new Promise(done=>{resolve=done;}),allowed:()=>true,render,restore});
    bubble.stateChanged("working"); const showing = bubble.show();
    expect(render).toHaveBeenCalledWith("正在查询费用…");
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
  it("latest click wins and errors remain short-lived plain text", async () => {
    vi.useFakeTimers();
    const resolvers: ((value:BillingSnapshot)=>void)[]=[]; const render=vi.fn(),restore=vi.fn();
    const bubble=new BillingBubble({read:()=>new Promise(done=>resolvers.push(done)),allowed:()=>true,render,restore});
    try {
      const first=bubble.show(),second=bubble.show();
      resolvers[1]?.(snapshot); await second; resolvers[0]?.({...snapshot,balance:{status:"ready",balances:[{currency:"CNY",remaining:999}]}}); await first;
      expect(render).toHaveBeenLastCalledWith(formatBilling(snapshot));
      bubble.cancel();
      const failed=new BillingBubble({read:async()=>{throw new Error("PRIVATE token");},allowed:()=>true,render,restore});
      await failed.show(); expect(render).toHaveBeenLastCalledWith("费用暂时无法查询，请稍后再试");
      await vi.advanceTimersByTimeAsync(10000); expect(failed.visible).toBe(false); failed.cancel();
    } finally {bubble.cancel();vi.useRealTimers();}
  });
});
