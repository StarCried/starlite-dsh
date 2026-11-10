import { expect, it } from "vitest";
import { CONTROL_LEASE_MS, parseControlAck, parseControlDesktopReport, parseControlFrame, parseControlPerform, parseControlRelease, parseControlStage } from "../src/index.js";
const id = "15c3a508-c0c7-4a6e-8c89-985e13ef5a72";
const envelope = { controlVersion: 1, sequence: 1, leaseId: id, commandId: id, leaseMs: CONTROL_LEASE_MS };
const report = { controlVersion: 1, enabled: true, available: true, model: { revision: id, title: "Model", animations: [{ name: "Wave", durationMs: 3000 }] }, preferences: { bubblesVisible: true, pointerEnabled: true, scale: 1 } };
it("round trips every allowlisted control operation", () => {
  for (const command of [{ kind: "acquire", sessionTitle: "Session" }, { kind: "activity" }, { kind: "perform", animation: "Wave", text: "hello\nworld", durationMs: 2000 }, { kind: "perform", stop: true }, { kind: "stage", position: { x: 0, y: 1 }, scale: .5, pointerEnabled: false }, { kind: "cancel", targetId: id }, { kind: "release", reason: "expired" }]) {
    expect(parseControlFrame({ ...envelope, ...command })).toEqual({ ...envelope, ...command });
  }
  expect(parseControlDesktopReport(report)).toEqual(report);
  expect(parseControlAck({ controlVersion: 1, leaseId: id, commandId: id, status: "rejected", reason: "user-preference" })).toMatchObject({ status: "rejected" });
  expect(parseControlRelease({ leaseId: id, reason: "user" })).toEqual({ leaseId: id, reason: "user" });
});
it("allows only a content-free bounded activity renewal envelope", () => {
  const activity = { ...envelope, kind: "activity" };
  expect(parseControlFrame(activity)).toEqual(activity);
  for (const extra of [{ text: "private response" }, { sessionId: "private" }, { durationMs: 1000 }, { leaseMs: 300001 }, { leaseId: "old session" }, { sequence: -1 }]) expect(() => parseControlFrame({ ...activity, ...extra })).toThrow();
});
it("rejects malformed identities, extra fields and unbounded commands", () => {
  for (const bad of [{ ...envelope, kind: "acquire", sessionTitle: "OK", sessionId: "private" }, { ...envelope, kind: "release", reason: "other" }, { ...envelope, kind: "cancel", targetId: "session" }, { ...envelope, sequence: .1, kind: "release", reason: "user" }, { ...envelope, leaseMs: 999999, kind: "release", reason: "user" }]) expect(() => parseControlFrame(bad)).toThrow();
  for (const bad of [{}, { text: "" }, { text: "a".repeat(1001) }, { text: "a\u202eb" }, { animation: "Wave", durationMs: 2000 }, { text: "ok", durationMs: 30001 }, { stop: true, text: "ignored" }, { animation: "Wave", loop: true }]) expect(() => parseControlPerform(bad)).toThrow();
  for (const bad of [{}, { position: { x: 2, y: 0 } }, { scale: NaN }, { scale: 2 }, { pointerEnabled: 1 }, { position: { x: .5, y: .5, monitor: "other" } }]) expect(() => parseControlStage(bad)).toThrow();
});
it("bounds capabilities and forbids false readiness or secret fields", () => {
  for (const bad of [{ ...report, model: undefined }, { ...report, enabled: "true" }, { ...report, model: { ...report.model, path: "private" } }, { ...report, model: { ...report.model, animations: [report.model.animations[0], report.model.animations[0]] } }, { ...report, model: { ...report.model, animations: Array.from({ length: 256 }, (_, i) => ({ name: `${i}${"字".repeat(150)}`, durationMs: 3000 })) } }]) expect(() => parseControlDesktopReport(bad)).toThrow();
  expect(parseControlDesktopReport({ controlVersion: 1, enabled: false, available: false, preferences: report.preferences }).model).toBeUndefined();
});
