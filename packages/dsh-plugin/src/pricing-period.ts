import type {BillingSnapshot} from "@starcried/starlite-dsh-protocol";

// Public DeepSeek rule, verified 2026-10-10:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing, excluding Chinese holidays.
// Public 2026 holiday schedule:
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const HOLIDAYS_2026 = [
  ["2026-01-01","2026-01-03"], ["2026-02-15","2026-02-23"],
  ["2026-04-04","2026-04-06"], ["2026-05-01","2026-05-05"],
  ["2026-06-19","2026-06-21"], ["2026-09-25","2026-09-27"],
  ["2026-10-01","2026-10-07"],
] as const;

/** Current published tariff period; does not infer past requests' billing time. */
export function deepSeekPricingPeriod(time: number): NonNullable<BillingSnapshot["pricingPeriod"]> {
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(beijing.getTime())) return "unknown";
  const weekday = beijing.getUTCDay(), minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  if (weekday === 0 || weekday === 6 || !(minutes >= 540 && minutes < 720 || minutes >= 840 && minutes < 1080)) return "off-peak";
  // Do not guess an unverified year's holiday calendar. Weekend makeup work
  // does not alter DeepSeek's explicit Monday-through-Friday pricing rule.
  if (beijing.getUTCFullYear() !== 2026) return "unknown";
  const date = beijing.toISOString().slice(0,10);
  return HOLIDAYS_2026.some(([start,end]) => date >= start && date <= end) ? "off-peak" : "peak";
}
