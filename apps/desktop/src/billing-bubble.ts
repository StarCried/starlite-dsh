import type { BillingCurrency, BillingSnapshot } from "@starcried/starlite-dsh-protocol";

export type BillingBubbleView = {status: "loading" | "error"} | {status: "ready"; snapshot: BillingSnapshot};

function money(amount: number): string {
  return amount === 0 ? "0" : amount < .0001 ? "<0.0001" : amount.toFixed(4);
}

function symbol(currency: BillingCurrency): string {return currency === "CNY" ? "¥" : "$";}

function estimateText(snapshot: BillingSnapshot, currency: BillingCurrency): string {
  const estimate = snapshot.today.estimates.find(item => item.currency === currency);
  if (!estimate || !(snapshot.today.pricedRequests > 0 || (!snapshot.today.partial && snapshot.today.unpricedRequests === 0))) return "暂不可用";
  const prefix = symbol(currency);
  return estimate.minimum === estimate.maximum ? `${prefix}${money(estimate.maximum)}`
    : `${prefix}${money(estimate.minimum)}–${money(estimate.maximum)}`;
}

function coverageNotes(snapshot: BillingSnapshot): string[] {
  return [snapshot.today.partial ? "部分记录" : "", snapshot.today.unpricedRequests ? `${snapshot.today.unpricedRequests} 次未计入` : ""].filter(Boolean);
}

function periodText(snapshot: BillingSnapshot): string {
  return snapshot.pricingPeriod === "peak" ? "当前高峰时段"
    : snapshot.pricingPeriod === "off-peak" ? "当前空闲时段（半价）" : "当前计价时段待确认";
}

/** Builds text-only content. Provider values and session titles never become HTML. */
export function renderBillingBubble(element: HTMLElement, view: BillingBubbleView, title?: string): void {
  const doc = element.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const result = doc.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const card = node("section", "billing-card");
  card.setAttribute("aria-label", "DeepSeek 费用");
  card.setAttribute("aria-busy", String(view.status === "loading"));
  const header = node("div", "billing-header");
  header.append(node("span", "billing-label", "DeepSeek 账户"));
  card.append(header);
  if (view.status === "ready") {
    const snapshot = view.snapshot;
    const balances = [...snapshot.balance.balances].sort((a, b) => Number(b.currency === "CNY") - Number(a.currency === "CNY"));
    const primary = balances[0];
    const sourceLabel = snapshot.balance.source === "deepseek-official" ? "默认官方配置"
      : snapshot.balance.source === "deepseek" ? "额外官方配置" : "账户余额";
    header.append(node("span", "billing-status", primary ? sourceLabel : "查询提示"));
    if (primary) {
      const remaining = node("div", "billing-balance");
      remaining.append(node("span", "billing-symbol", symbol(primary.currency)), node("strong", "billing-amount", primary.remaining.toFixed(2)), node("span", "billing-currency", primary.currency));
      card.append(remaining);
      if (balances.length > 1) card.append(node("div", "billing-secondary", balances.slice(1).map(item => `${item.currency} ${symbol(item.currency)}${item.remaining.toFixed(2)}`).join(" · ")));
    } else {
      card.append(node("div", "billing-message", snapshot.balance.status === "unconfigured" ? "请先配置官方 DeepSeek" : "暂时无法查询余额"));
      card.append(node("p", "billing-hint", snapshot.balance.status === "unconfigured" ? "在 DSH 的模型设置中配置官方账户。" : "请检查账户配置与网络，稍后再试。"));
    }
    const today = node("div", "billing-today");
    today.append(node("span", "billing-label", "今日 DSH 估算"));
    const amounts = node("span", "billing-estimates");
    const currencies: BillingCurrency[] = snapshot.today.estimates.length ? snapshot.today.estimates.map(item => item.currency) : [primary?.currency ?? "CNY"];
    for (const currency of currencies) amounts.append(node("span", "billing-estimate", estimateText(snapshot, currency)));
    today.append(amounts);card.append(today);
    const notes = coverageNotes(snapshot);
    card.append(node("p", "billing-hint", [...notes, "各官方模型用量区间估算 · 以账单为准"].join(" · ")));
    const footer = node("div", "billing-footer");
    const period = node("span", "billing-period", periodText(snapshot));
    period.dataset.period = snapshot.pricingPeriod ?? "unknown";
    footer.append(period, node("span", "billing-timezone", "北京时间"));card.append(footer);
  } else {
    header.append(node("span", "billing-status", view.status === "loading" ? "查询中" : "暂不可用"));
    card.append(node("div", "billing-message", view.status === "loading" ? "正在查询余额与费用…" : "费用暂时无法查询"));
    card.append(node("p", "billing-hint", view.status === "loading" ? "读取账户余额与今日 DSH 用量。" : "请检查账户配置与网络，稍后再试。"));
  }
  const heading = title ? node("span", "bubble-title", title) : undefined;
  element.replaceChildren(...(heading ? [heading, card] : [card]));
  element.dataset.bubbleKind = "billing";
  delete element.dataset.bubbleMode;
  element.dataset.interactive = "true";
  element.hidden = false;
}

/** A short click overlay, cancelled by state/privacy/connection changes. */
export class BillingBubble {
  readonly #read: () => Promise<BillingSnapshot>;
  readonly #allowed: () => boolean;
  readonly #render: (view: BillingBubbleView) => void;
  readonly #restore: () => void;
  #generation = 0;
  #visible = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #state: string | undefined;
  get visible(): boolean {return this.#visible;}
  constructor(options: {read: () => Promise<BillingSnapshot>; allowed: () => boolean; render: (view: BillingBubbleView) => void; restore: () => void}) {
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
    this.#visible = true; this.#render({status: "loading"});
    try {
      const snapshot = await this.#read();
      if (generation !== this.#generation) return;
      if (!this.#allowed()) {this.cancel(); return;}
      this.#render({status: "ready", snapshot});
    } catch {
      if (generation !== this.#generation) return;
      if (!this.#allowed()) {this.cancel(); return;}
      this.#render({status: "error"});
    }
    this.#timer = setTimeout(() => this.cancel(), 10_000);
  }
}
