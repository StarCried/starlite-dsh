import type { BillingSnapshot } from "@dsh-inochi2d-pet/protocol";

export function formatBilling(snapshot: BillingSnapshot): string {
  const balance = snapshot.balance.balances.find(item => item.currency === "CNY") ?? snapshot.balance.balances[0];
  const currency = balance?.currency ?? "CNY";
  const symbol = currency === "CNY" ? "¥" : "$";
  const remaining = balance ? `余额 ${symbol}${balance.remaining.toFixed(2)}`
    : snapshot.balance.status === "unconfigured" ? "余额：请先配置官方 DeepSeek" : "余额：暂时无法查询";
  const estimate = snapshot.today.estimates.find(item => item.currency === currency);
  const money = (amount: number) => amount === 0 ? "0" : amount < .0001 ? "<0.0001" : amount.toFixed(4);
  const cost = estimate && (snapshot.today.pricedRequests > 0 || (!snapshot.today.partial && snapshot.today.unpricedRequests === 0))
    ? `${symbol}${money(estimate.minimum)}–${money(estimate.maximum)}` : "暂不可用";
  const notes = [snapshot.today.partial ? "部分记录" : "", snapshot.today.unpricedRequests ? `${snapshot.today.unpricedRequests} 次未计入` : ""].filter(Boolean);
  return `${remaining}\n今日 DSH 估算 ${cost}\n${notes.length ? notes.join(" · ") : "北京时间 · 高峰/空闲区间"}`;
}

/** A short click overlay, cancelled by state/privacy/connection changes. */
export class BillingBubble {
  readonly #read: () => Promise<BillingSnapshot>;
  readonly #allowed: () => boolean;
  readonly #render: (text: string) => void;
  readonly #restore: () => void;
  #generation = 0;
  #visible = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #state: string | undefined;
  get visible(): boolean {return this.#visible;}
  constructor(options: {read: () => Promise<BillingSnapshot>; allowed: () => boolean; render: (text: string) => void; restore: () => void}) {
    this.#read = options.read; this.#allowed = options.allowed; this.#render = options.render; this.#restore = options.restore;
  }
  stateChanged(state: string): void {
    if (state !== this.#state) this.cancel();
    this.#state = state;
  }
  cancel(): void {
    ++this.#generation;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#visible) {this.#visible = false; this.#restore();}
  }
  async show(): Promise<void> {
    if (!this.#allowed()) return;
    this.cancel(); const generation = this.#generation;
    this.#visible = true; this.#render("正在查询费用…");
    try {
      const snapshot = await this.#read();
      if (generation !== this.#generation) return;
      if (!this.#allowed()) {this.cancel(); return;}
      this.#render(formatBilling(snapshot));
    } catch {
      if (generation !== this.#generation) return;
      if (!this.#allowed()) {this.cancel(); return;}
      this.#render("费用暂时无法查询，请稍后再试");
    }
    this.#timer = setTimeout(() => this.cancel(), 10_000);
  }
}
