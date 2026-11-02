import { describe, expect, it } from "vitest";
import { parseBillingSnapshot } from "../src/index.js";

const valid = {
  billingVersion: 1, checkedAt: 1000,
  balance: {status: "ready", balances: [{currency: "CNY", remaining: 123.45}]},
  today: {date: "2026-10-08", timeZone: "Asia/Shanghai", partial: false, pricedRequests: 2, unpricedRequests: 0,
    pricingDate: "2026-10-08", estimates: [{currency: "CNY", minimum: .1, maximum: .2}]},
};
describe("billing boundary", () => {
  const account = {
    ...valid,
    balance: {status:"ready",source:"deepseek-account",balances:[{currency:"CNY",remaining:109.89}],bonusBalances:[{currency:"CNY",remaining:.21}]},
    today:{...valid.today,scope:"account",partial:true,pricedRequests:0,unpricedRequests:0,estimates:[]},
  };
  it("projects account wallets separately without leaking profile or credentials", () => {
    expect(parseBillingSnapshot({...account,token:"PRIVATE",balance:{...account.balance,profile:{phone:"PRIVATE"},
      bonusBalances:[{currency:"CNY",remaining:.21,token:"PRIVATE"}]}})).toEqual(account);
    const empty = {...account,balance:{...account.balance,balances:[],bonusBalances:[]}};
    expect(parseBillingSnapshot(empty)).toEqual(empty);
    expect(parseBillingSnapshot({...empty,balance:{...empty.balance,status:"unavailable"}}).balance.status).toBe("unavailable");
  });
  it("rejects mixed account/API charges and malformed or unscoped bonus amounts", () => {
    for (const value of [
      {...account,pricingPeriod:"off-peak"},
      {...account,today:{...account.today,scope:"api-key"}},
      {...account,today:{...account.today,partial:false}},
      {...account,today:{...account.today,pricedRequests:1}},
      {...account,today:{...account.today,estimates:[{currency:"CNY",minimum:0,maximum:0}]}},
      {...account,balance:{...account.balance,status:"unavailable"}},
      {...account,balance:{...account.balance,bonusBalances:undefined}},
      {...account,balance:{...account.balance,bonusBalances:[{currency:"CNY",remaining:Infinity}]}},
      {...account,balance:{...account.balance,bonusBalances:[{currency:"CNY",remaining:1},{currency:"CNY",remaining:2}]}},
      {...valid,balance:{...valid.balance,bonusBalances:[]}},
      {...valid,today:{...valid.today,scope:"account"}},
    ]) expect(() => parseBillingSnapshot(value)).toThrow();
  });
  it("preserves bounded exact account amounts and rejects mismatched or nonnumeric decimals", () => {
    const exact = {...account,balance:{...account.balance,balances:[{currency:"CNY",remaining:109.899,decimal:"109.89900000000000"}],
      bonusBalances:[{currency:"CNY",remaining:0,decimal:"1e-999"}]}};
    expect(parseBillingSnapshot(exact)).toEqual(exact);
    for (const decimal of ["109.89", "PRIVATE", "NaN", " 109.899", "109.899"+"0".repeat(129)]) {
      expect(() => parseBillingSnapshot({...exact,balance:{...exact.balance,balances:[{currency:"CNY",remaining:109.899,decimal}]}})).toThrow();
    }
    expect(() => parseBillingSnapshot({...valid,balance:{...valid.balance,balances:[{currency:"CNY",remaining:123.45,decimal:"123.45"}]}})).toThrow();
  });
  it("reconstructs only financial fields", () => {
    const parsed = parseBillingSnapshot({...valid, secret: "PRIVATE", balance: {...valid.balance, key: "PRIVATE"}});
    expect(parsed).toEqual(valid);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    expect(parseBillingSnapshot({...valid,pricingPeriod:"off-peak",balance:{...valid.balance,source:"deepseek-official"}}))
      .toEqual({...valid,pricingPeriod:"off-peak",balance:{...valid.balance,source:"deepseek-official"}});
    expect(parseBillingSnapshot({...valid,balance:{status:"ready",balances:[{currency:"CNY",remaining:-.25}]}}).balance.balances[0]?.remaining).toBe(-.25);
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
      {...valid,pricingPeriod:"PRIVATE unknown period"},
      {...valid,balance:{...valid.balance,source:"PRIVATE account"}},
      {...valid,balance:{status:"unconfigured",balances:[],source:"deepseek-official"}},
    ]) expect(() => parseBillingSnapshot(value)).toThrow();
  });
});
