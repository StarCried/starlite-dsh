import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CONTROL_LEASE_MS, type ControlDesktopReport, type ControlFrame } from "@starcried/starlite-dsh-protocol";
import { SessionControl } from "../src/session-control.js";

const controls: SessionControl[] = [];
afterEach(() => { for (const item of controls.splice(0)) item.close(); vi.useRealTimers(); });
function setup() {
  const control = new SessionControl(), frames: ControlFrame[] = [];
  const report: ControlDesktopReport = { controlVersion: 1, enabled: true, available: true, model: { revision: randomUUID(), title: "Model", animations: [{ name: "Wave", durationMs: 3000 }, { name: "Long", durationMs: 60_000 }] }, preferences: { bubblesVisible: true, pointerEnabled: true, scale: 1 } };
  controls.push(control); control.subscribe(frame => frames.push(frame)); control.setConnected(true); control.report(report);
  const ack = (frame: ControlFrame, status: "started" | "completed" | "interrupted" | "stopped" | "rejected" = "completed") => control.acknowledge({ controlVersion: 1, leaseId: frame.leaseId, commandId: frame.commandId, status });
  const session = { privateId: "do-not-send" }, signal = new AbortController().signal;
  const acquire = async () => { const pending = control.acquire(session, "My session", signal); ack(frames.at(-1)!); expect(await pending).toEqual({ status: "completed" }); };
  return { control, frames, report, ack, session, signal, acquire };
}
it("requires enabled connected model and one actual session owner", async () => {
  const { control, report, acquire, session, signal, frames } = setup();
  control.report({ ...report, enabled: false }); expect(await control.acquire(session, "title", signal)).toEqual({ status: "rejected", reason: "disabled" });
  control.report(report); await acquire();
  expect(await control.acquire({ privateId: "do-not-send" }, "forged", signal)).toEqual({ status: "rejected", reason: "busy" });
  expect(await control.perform({}, { animation: "Wave" }, signal)).toEqual({ status: "rejected", reason: "busy" });
  expect(control.relinquish({})).toEqual({ status: "rejected", reason: "not-owner" });
  expect(JSON.stringify(frames)).not.toContain("privateId"); expect(JSON.stringify(frames)).not.toContain("do-not-send");
  expect(control.inspect(session)).toMatchObject({ controlledBySelf: true, busy: false });
});
it("waits for actual completion and ignores late or foreign acknowledgements", async () => {
  const { control, frames, ack, acquire, session, signal } = setup(); await acquire();
  const pending = control.perform(session, { animation: "Wave", text: "Hello" }, signal), frame = frames.at(-1)!, finished = vi.fn(); void pending.then(finished);
  ack(frame, "started"); await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
  control.acknowledge({ controlVersion: 1, leaseId: randomUUID(), commandId: frame.commandId, status: "completed" }); await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
  ack(frame); expect(await pending).toEqual({ status: "completed" }); ack(frame, "rejected"); expect(control.active).toBe(true);
});
it("does not cancel an in-flight acquisition and renews an acknowledged lease idempotently", async () => {
  const { control, frames, ack, session, signal } = setup();
  const first = control.acquire(session, "Title", signal), frame = frames.at(-1)!;
  expect(await control.acquire(session, "Title", signal)).toEqual({ status: "rejected", reason: "busy" }); expect(frames).toHaveLength(1);
  ack(frame); await first;
  const renewed = control.acquire(session, "Title", signal), renewal = frames.at(-1)!;
  expect(renewal.kind).toBe("acquire"); expect(renewal.leaseId).toBe(frame.leaseId); expect(renewal.commandId).not.toBe(frame.commandId);
  ack(renewal); expect(await renewed).toEqual({ status: "completed" });
});
it("latest performance wins without a queue or cross-session cancellation", async () => {
  const { control, frames, ack, acquire, session, signal } = setup(); await acquire();
  const old = control.perform(session, { animation: "Wave" }, signal), oldFrame = frames.at(-1)!;
  const next = control.perform(session, { text: "Next", durationMs: 1000 }, signal), nextFrame = frames.at(-1)!;
  expect(await old).toEqual({ status: "interrupted", reason: "superseded" });
  expect(frames.at(-2)).toMatchObject({ kind: "cancel", targetId: oldFrame.commandId });
  ack(oldFrame); ack(nextFrame); expect(await next).toEqual({ status: "completed" });
});
it("rejects invalid animation and disabled speech atomically", async () => {
  const { control, frames, report, acquire, session, signal } = setup(); await acquire(); const length = frames.length;
  expect(await control.perform(session, { animation: "missing", text: "Hi" }, signal)).toMatchObject({ reason: "unknown-animation" });
  expect(await control.perform(session, { animation: "Long" }, signal)).toMatchObject({ reason: "animation-too-long" });
  control.report({ ...report, preferences: { ...report.preferences, bubblesVisible: false } });
  expect(await control.perform(session, { animation: "Wave", text: "Hi" }, signal)).toMatchObject({ reason: "user-preference" });
  expect(frames).toHaveLength(length); expect(control.active).toBe(true);
});
it("abort cancels owned execution and returns normal behavior", async () => {
  const { control, frames, acquire, session } = setup(); await acquire(); const abort = new AbortController();
  const pending = control.perform(session, { text: "Hi" }, abort.signal); abort.abort();
  expect(await pending).toEqual({ status: "interrupted", reason: "cancelled" }); expect(control.active).toBe(false);
  expect(frames.at(-1)).toMatchObject({ kind: "release", reason: "cancelled" });
});
it.each(["model-changed", "unavailable", "disabled", "disconnected", "session-ended", "user"] as const)("releases pending work on %s", async reason => {
  const { control, frames, acquire, session, signal, report } = setup(); await acquire(); const leaseId = frames.at(-1)!.leaseId;
  const pending = control.stage(session, { position: { x: .3, y: .5 } }, signal);
  if (reason === "model-changed") control.report({ ...report, model: { ...report.model!, revision: randomUUID() } });
  else if (reason === "unavailable") control.report({ ...report, available: false });
  else if (reason === "disabled") control.report({ ...report, enabled: false });
  else if (reason === "disconnected") control.setConnected(false);
  else if (reason === "session-ended") control.releaseSession(session);
  else control.userRelease({ leaseId, reason: "user" });
  expect(await pending).toEqual({ status: "interrupted", reason }); expect(control.active).toBe(false);
  expect(frames.at(-1)).toMatchObject({ kind: "release", reason });
});
it("expires a renewed relative lease and rejects delayed release from an older lease", async () => {
  vi.useFakeTimers(); const { control, frames, ack, acquire, session, signal } = setup(); await acquire(); const oldLease = frames.at(-1)!.leaseId;
  await vi.advanceTimersByTimeAsync(CONTROL_LEASE_MS - 1000);
  const renewed = control.acquire(session, "Title", signal); ack(frames.at(-1)!); await renewed;
  await vi.advanceTimersByTimeAsync(2000); expect(control.active).toBe(true);
  await vi.advanceTimersByTimeAsync(CONTROL_LEASE_MS); expect(control.active).toBe(false); expect(frames.at(-1)).toMatchObject({ kind: "release", reason: "expired" });
  await acquire(); control.userRelease({ leaseId: oldLease, reason: "user" }); expect(control.active).toBe(true);
});
it("bounds missing start and missing completion with cancellation", async () => {
  vi.useFakeTimers(); const { control, frames, ack, acquire, session, signal } = setup(); await acquire();
  const unstarted = control.perform(session, { text: "Hi" }, signal); await vi.advanceTimersByTimeAsync(4000);
  expect(await unstarted).toEqual({ status: "rejected", reason: "timeout" }); expect(frames.at(-1)?.kind).toBe("cancel");
  const stuck = control.perform(session, { text: "Hi", durationMs: 1000 }, signal); ack(frames.at(-1)!, "started"); await vi.advanceTimersByTimeAsync(6000);
  expect(await stuck).toEqual({ status: "rejected", reason: "timeout" });
});
it("has a bounded acquisition watchdog and no replay after reconnect", async () => {
  vi.useFakeTimers(); const { control, frames, session, signal, report } = setup();
  const pending = control.acquire(session, "Title", signal); await vi.advanceTimersByTimeAsync(4000);
  expect(await pending).toEqual({ status: "rejected", reason: "timeout" }); expect(control.active).toBe(false);
  const length = frames.length; control.setConnected(false); control.setConnected(true); control.report(report); expect(frames).toHaveLength(length);
});
it("rejects overlapping placement and releases its lease if native placement times out", async () => {
  vi.useFakeTimers(); const { control, frames, ack, acquire, session, signal } = setup(); await acquire();
  const first = control.stage(session, { scale: 1.2 }, signal), frame = frames.at(-1)!; ack(frame, "started");
  expect(await control.stage(session, { scale: 1.3 }, signal)).toEqual({ status: "rejected", reason: "busy" });
  await vi.advanceTimersByTimeAsync(4000); expect(await first).toEqual({ status: "rejected", reason: "timeout" });
  expect(control.active).toBe(false); expect(frames.at(-1)).toMatchObject({ kind: "release", reason: "unavailable" });
  ack(frame); expect(control.active).toBe(false);
});
it("ignores delayed acquisition ACK after cancellation and opens only the lease owner's session", async () => {
  const navigate = vi.fn(async (_session: unknown) => undefined), control = new SessionControl(navigate); controls.push(control);
  const { report } = setup(), frames: ControlFrame[] = []; control.subscribe(frame => frames.push(frame)); control.setConnected(true); control.report(report);
  const session = {}, abort = new AbortController(), acquiring = control.acquire(session, "Title", abort.signal), frame = frames.at(-1)!;
  abort.abort(); expect(await acquiring).toMatchObject({ status: "interrupted" });
  control.acknowledge({ controlVersion: 1, leaseId: frame.leaseId, commandId: frame.commandId, status: "completed" }); expect(control.active).toBe(false);
  const acquired = control.acquire(session, "Title", new AbortController().signal), next = frames.at(-1)!;
  control.acknowledge({ controlVersion: 1, leaseId: next.leaseId, commandId: next.commandId, status: "completed" }); await acquired;
  await expect(control.open({ leaseId: frame.leaseId })).rejects.toThrow();
  await expect(control.open({ leaseId: next.leaseId, sessionId: "forged" })).rejects.toThrow();
  await control.open({ leaseId: next.leaseId }); expect(navigate).toHaveBeenCalledExactlyOnceWith(session);
  control.relinquish(session); await expect(control.open({ leaseId: next.leaseId })).rejects.toThrow();
});
