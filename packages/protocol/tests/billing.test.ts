import { describe, expect, it } from "vitest";
import { parseBillingSnapshot } from "../src/index.js";

const valid = {
  billingVersion: 1, checkedAt: 1000,
  balance: {status: "ready", balances: [{currency: "CNY", remaining: 123.45}]},
  today: {date: "2026-10-08", timeZone: "Asia/Shanghai", partial: false, pricedRequests: 2, unpricedRequests: 0,
    pricingDate: "2026-10-08", estimates: [{currency: "CNY", minimum: .1, maximum: .2}]},
};
describe("billing boundary", () => {
  it("reconstructs only financial fields", () => {
    const parsed = parseBillingSnapshot({...valid, secret: "PRIVATE", balance: {...valid.balance, key: "PRIVATE"}});
    expect(parsed).toEqual(valid);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });
  it("rejects malformed, duplicate, excessive and misleading financial fields", () => {
    for (const value of [null, {...valid,billingVersion:2}, {...valid,checkedAt:NaN},
      {...valid,balance:{status:"unavailable",balances:valid.balance.balances}},
      {...valid,balance:{status:"ready",balances:[]}},
      {...valid,balance:{status:"ready",balances:[{currency:"CNY",remaining:"10"}]}},
      {...valid,balance:{status:"ready",balances:[...valid.balance.balances,...valid.balance.balances]}},
      {...valid,today:{...valid.today,date:"2026-02-30"}},
      {...valid,today:{...valid.today,estimates:[{currency:"CNY",minimum:.2,maximum:.1}]}},
      {...valid,today:{...valid.today,unpricedRequests:-1}},
    ]) expect(() => parseBillingSnapshot(value)).toThrow();
  });
});
