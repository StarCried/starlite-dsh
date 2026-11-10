import { randomUUID } from "node:crypto";
import { CONTROL_LEASE_MS, isOpaqueRef, parseControlAck, parseControlDesktopReport, parseControlFrame, parseControlPerform, parseControlRelease, parseControlStage, sanitizeBubbleText,
  type ControlAck, type ControlDesktopReport, type ControlFrame, type ControlPerform, type ControlReleaseReason, type ControlStage } from "@starcried/starlite-dsh-protocol";

export interface ControlResult { status: ControlAck["status"]; reason?: string }
type Command = { kind: "acquire"; sessionTitle: string } | ({ kind: "perform" } & ControlPerform) | ({ kind: "stage" } & ControlStage) | { kind: "cancel"; targetId: string } | { kind: "release"; reason: ControlReleaseReason };
interface Owner { session: unknown; leaseId: string; title: string; timer: ReturnType<typeof setTimeout> }
interface Pending { frame: ControlFrame; started: boolean; timer: ReturnType<typeof setTimeout>; finish(result: ControlResult): void }
const ACK_TIMEOUT_MS = 4000;

/** A Host-local lease. Only SDK execution identity may select its session owner. */
export class SessionControl {
  private desktop: ControlDesktopReport | undefined;
  private connected = false;
  private owner: Owner | undefined;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(frame: ControlFrame) => void>();
  private readonly availability = new Set<() => void>();
  constructor(private readonly openSession?: (session: unknown) => Promise<void>) {}

  get active(): boolean { return this.owner !== undefined; }
  get enabled(): boolean { return !this.closed && this.desktop?.enabled === true; }
  get ready(): boolean { return this.enabled && this.connected && this.desktop?.available === true && !!this.desktop.model; }
  subscribe(listener: (frame: ControlFrame) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onChange(listener: () => void): () => void { this.availability.add(listener); return () => this.availability.delete(listener); }
  report(value: unknown): void {
    const report = parseControlDesktopReport(value), previous = this.desktop;
    this.desktop = report;
    if (this.owner) {
      if (!report.enabled) this.release("disabled");
      else if (!report.available) this.release("unavailable");
      else if (previous?.model?.revision !== report.model?.revision) this.release("model-changed");
    }
    this.changed();
  }
  setConnected(value: boolean): void {
    this.connected = value;
    if (!value) { this.release("disconnected"); this.desktop = undefined; }
    this.changed();
  }
  inspect(session: unknown): object {
    return { enabled: this.enabled, available: this.ready, controlledBySelf: !!this.owner && this.owner.session === session, busy: this.active && this.owner?.session !== session,
      leaseMs: CONTROL_LEASE_MS,
      ...(this.desktop?.model ? { model: { title: this.desktop.model.title, animations: this.desktop.model.animations.map(item => ({ ...item })) } } : {}),
      ...(this.desktop ? { preferences: { ...this.desktop.preferences } } : {}) };
  }
  async acquire(session: unknown, title: unknown, signal: AbortSignal): Promise<ControlResult> {
    if (signal.aborted) return result("interrupted", "cancelled");
    if (!this.ready) return result("rejected", this.enabled ? "unavailable" : "disabled");
    if (this.owner && this.owner.session !== session) return result("rejected", "busy");
    if ([...this.pending.values()].some(item => item.frame.kind === "acquire")) return result("rejected", "busy");
    if (!this.owner) {
      this.owner = { session, leaseId: randomUUID(), title: sanitizeBubbleText(title, 60).slice(0, 120) || "DSH session", timer: setTimeout(() => this.release("expired"), CONTROL_LEASE_MS) };
      this.owner.timer.unref(); this.changed();
    }
    this.renew();
    const leaseId = this.owner.leaseId;
    const outcome = await this.send({ kind: "acquire", sessionTitle: this.owner.title }, signal, ACK_TIMEOUT_MS);
    if (outcome.status === "rejected" && this.owner?.leaseId === leaseId) this.release("unavailable");
    return outcome;
  }
  relinquish(session: unknown): ControlResult {
    if (!this.owner) return result("completed");
    if (this.owner.session !== session) return result("rejected", "not-owner");
    this.release("user"); return result("completed");
  }
  renewLease(session: unknown, title: unknown, signal: AbortSignal): Promise<ControlResult> {
    const denied = this.authorize(session, signal); return denied ? Promise.resolve(denied) : this.acquire(session, title, signal);
  }
  async perform(session: unknown, value: unknown, signal: AbortSignal): Promise<ControlResult> {
    const command = parseControlPerform(value), denied = this.authorize(session, signal); if (denied) return denied;
    const animation = command.animation === undefined ? undefined : this.desktop?.model?.animations.find(item => item.name === command.animation);
    if (command.animation !== undefined && !animation) return result("rejected", "unknown-animation");
    if (animation && animation.durationMs > 30_000) return result("rejected", "animation-too-long");
    if (command.text !== undefined && !this.desktop?.preferences.bubblesVisible) return result("rejected", "user-preference");
    this.interruptKind("perform"); this.renew();
    return this.send({ kind: "perform", ...command }, signal, Math.max(animation?.durationMs ?? 0, command.durationMs ?? (command.text ? 6000 : 0)) + 5000);
  }
  async stage(session: unknown, value: unknown, signal: AbortSignal): Promise<ControlResult> {
    const command = parseControlStage(value), denied = this.authorize(session, signal); if (denied) return denied;
    // Native placement is asynchronous. Cancelling it restores the entire
    // stage baseline, so a concurrent replacement must not race that restore.
    if ([...this.pending.values()].some(item => item.frame.kind === "stage")) return result("rejected", "busy");
    this.renew();
    return this.send({ kind: "stage", ...command }, signal, ACK_TIMEOUT_MS);
  }
  acknowledge(value: unknown): void {
    const ack = parseControlAck(value), pending = this.pending.get(ack.commandId);
    if (!pending || ack.leaseId !== this.owner?.leaseId || ack.leaseId !== pending.frame.leaseId) return;
    if (ack.status === "started") { pending.started = true; return; }
    pending.finish({ status: ack.status, ...(ack.reason ? { reason: ack.reason } : {}) });
  }
  userRelease(value: unknown): void {
    const request = parseControlRelease(value);
    if (request.leaseId === this.owner?.leaseId) this.release(request.reason);
  }
  async open(value: unknown): Promise<void> {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (!row || Object.keys(row).length !== 1 || !isOpaqueRef(row.leaseId) || row.leaseId !== this.owner?.leaseId || !this.openSession) throw Error("session control unavailable");
    await this.openSession(this.owner.session);
  }
  releaseSession(session: unknown, reason: "session-ended" | "cancelled" = "session-ended"): void { if (this.owner?.session === session) this.release(reason); }
  close(): void { if (this.closed) return; this.release("unavailable"); this.closed = true; this.desktop = undefined; this.listeners.clear(); this.changed(); this.availability.clear(); }

  private authorize(session: unknown, signal: AbortSignal): ControlResult | undefined {
    if (signal.aborted) { if (this.owner?.session === session) this.release("cancelled"); return result("interrupted", "cancelled"); }
    if (!this.ready) return result("rejected", this.enabled ? "unavailable" : "disabled");
    if (!this.owner || this.owner.session !== session) return result("rejected", this.owner ? "busy" : "not-owner");
    return undefined;
  }
  private renew(): void { if (this.owner) { clearTimeout(this.owner.timer); this.owner.timer = setTimeout(() => this.release("expired"), CONTROL_LEASE_MS); this.owner.timer.unref(); } }
  private changed(): void { for (const listener of this.availability) { try { listener(); } catch { /* Optional observers cannot break Host control. */ } } }
  private emit(command: Command): ControlFrame {
    if (!this.owner) throw Error("session control unavailable");
    const frame = parseControlFrame({ controlVersion: 1, sequence: ++this.sequence, leaseId: this.owner.leaseId, commandId: randomUUID(), leaseMs: CONTROL_LEASE_MS, ...command });
    for (const listener of this.listeners) { try { listener(frame); } catch { /* Failed sockets are handled by disconnect and ACK deadlines. */ } }
    return frame;
  }
  private send(command: Command, signal: AbortSignal, duration: number): Promise<ControlResult> {
    if (!this.owner || signal.aborted) return Promise.resolve(result("interrupted", "cancelled"));
    return new Promise(resolve => {
      // Register before emitting: a local transport may acknowledge synchronously.
      const frame = parseControlFrame({ controlVersion: 1, sequence: ++this.sequence, leaseId: this.owner!.leaseId, commandId: randomUUID(), leaseMs: CONTROL_LEASE_MS, ...command });
      let done = false;
      const abort = () => this.release("cancelled");
      const finish = (outcome: ControlResult) => {
        if (done) return; done = true; clearTimeout(pending.timer); clearTimeout(startTimer); signal.removeEventListener("abort", abort); this.pending.delete(frame.commandId); resolve(outcome);
      };
      const timeout = () => { if (done) return; this.emit({ kind: "cancel", targetId: frame.commandId }); finish(result("rejected", "timeout")); if (frame.kind === "stage" || frame.kind === "acquire") this.release("unavailable"); };
      const pending: Pending = { frame, started: false, timer: setTimeout(timeout, Math.min(35_000, Math.max(ACK_TIMEOUT_MS, duration))), finish };
      const startTimer = setTimeout(() => { if (!pending.started) timeout(); }, ACK_TIMEOUT_MS);
      pending.timer.unref(); startTimer.unref(); this.pending.set(frame.commandId, pending); signal.addEventListener("abort", abort, { once: true });
      for (const listener of this.listeners) { try { listener(frame); } catch { /* Await bounded ACK deadline. */ } }
    });
  }
  private interruptKind(kind: ControlFrame["kind"]): void {
    for (const pending of this.pending.values()) if (pending.frame.kind === kind) {
      this.emit({ kind: "cancel", targetId: pending.frame.commandId }); pending.finish(result("interrupted", "superseded"));
    }
  }
  private release(reason: ControlReleaseReason): void {
    if (!this.owner) return;
    clearTimeout(this.owner.timer);
    for (const pending of this.pending.values()) pending.finish(result("interrupted", reason));
    this.emit({ kind: "release", reason }); this.owner = undefined; this.changed();
  }
}
function result(status: ControlResult["status"], reason?: string): ControlResult { return { status, ...(reason ? { reason } : {}) }; }
