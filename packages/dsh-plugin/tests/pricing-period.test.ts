import {describe,expect,it} from "vitest";
import {deepSeekPricingPeriod} from "../src/pricing-period.js";

describe("published DeepSeek pricing period", () => {
  it.each([
    ["2026-10-09T08:59:59+08:00","off-peak"],
    ["2026-10-09T09:00:00+08:00","peak"],
    ["2026-10-09T11:59:59+08:00","peak"],
    ["2026-10-09T12:00:00+08:00","off-peak"],
    ["2026-10-09T14:00:00+08:00","peak"],
    ["2026-10-09T17:59:59+08:00","peak"],
    ["2026-10-09T18:00:00+08:00","off-peak"],
    ["2026-10-01T10:00:00+08:00","off-peak"],
    ["2026-10-07T10:00:00+08:00","off-peak"],
    ["2026-10-08T10:00:00+08:00","peak"],
    ["2026-10-10T10:00:00+08:00","off-peak"],
    ["2026-10-11T10:00:00+08:00","off-peak"],
    ["2026-02-20T10:00:00+08:00","off-peak"],
    ["2027-01-04T10:00:00+08:00","unknown"],
    ["2027-01-04T20:00:00+08:00","off-peak"],
  ])("uses Beijing boundaries and the verified holiday calendar: %s", (time, expected) => {
    expect(deepSeekPricingPeriod(Date.parse(time))).toBe(expected);
  });
  it("does not depend on the host timezone or invent an invalid date", () => {
    expect(deepSeekPricingPeriod(Date.parse("2026-10-09T01:00:00Z"))).toBe("peak");
    expect(deepSeekPricingPeriod(NaN)).toBe("unknown");
  });
});
