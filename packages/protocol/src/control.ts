import { isOpaqueRef } from "./interaction.js";

export const MAX_CONTROL_BYTES = 32_768;
export const CONTROL_LEASE_MS = 300_000;
export interface ControlDesktopReport {
  controlVersion: 1;
  enabled: boolean;
  available: boolean;
  model?: { revision: string; title: string; animations: Array<{ name: string; durationMs: number }> };
  preferences: { bubblesVisible: boolean; pointerEnabled: boolean; scale: number };
}
export const CONTROL_RELEASE_REASONS = ["user", "model-changed", "unavailable", "expired", "disconnected", "session-ended", "disabled", "cancelled"] as const;
export type ControlReleaseReason = typeof CONTROL_RELEASE_REASONS[number];
export interface ControlPerform { animation?: string; text?: string; durationMs?: number; stop?: true }
export interface ControlStage { position?: { x: number; y: number }; scale?: number; pointerEnabled?: boolean }
interface ControlEnvelope { controlVersion: 1; sequence: number; leaseId: string; commandId: string; leaseMs: number }
export type ControlFrame = ControlEnvelope & (
  | { kind: "acquire"; sessionTitle: string }
  | ({ kind: "perform" } & ControlPerform)
  | ({ kind: "stage" } & ControlStage)
  | { kind: "cancel"; targetId: string }
  | { kind: "release"; reason: ControlReleaseReason }
);
export interface ControlAck {
  controlVersion: 1; leaseId: string; commandId: string;
  status: "started" | "completed" | "interrupted" | "stopped" | "rejected";
  reason?: "unavailable" | "unknown-animation" | "user-preference" | "stale" | "failed";
}
export interface ControlRelease { leaseId: string; reason: "user" | "model-changed" | "unavailable" }

export function parseControlDesktopReport(value: unknown): ControlDesktopReport {
  const row = object(value, ["controlVersion", "enabled", "available", "model", "preferences"]);
  version(row);
  const preferences = object(row.preferences, ["bubblesVisible", "pointerEnabled", "scale"]);
  const result: ControlDesktopReport = { controlVersion: 1, enabled: boolean(row.enabled), available: boolean(row.available), preferences: {
    bubblesVisible: boolean(preferences.bubblesVisible), pointerEnabled: boolean(preferences.pointerEnabled), scale: number(preferences.scale, .25, 3),
  } };
  if (row.model !== undefined) {
    const model = object(row.model, ["revision", "title", "animations"]);
    if (!Array.isArray(model.animations) || model.animations.length > 256) throw Error("invalid animation catalog");
    const names = new Set<string>();
    result.model = { revision: ref(model.revision), title: text(model.title, 120), animations: model.animations.map(value => {
      const item = object(value, ["name", "durationMs"]), name = text(item.name, 160);
      if (names.has(name)) throw Error("duplicate animation"); names.add(name);
      return { name, durationMs: number(item.durationMs, 0, 3_600_000) };
    }) };
  }
  if (result.available && !result.model) throw Error("available model missing");
  return bounded(result);
}
export function parseControlPerform(value: unknown): ControlPerform {
  const row = object(value, ["animation", "text", "durationMs", "stop"]), result: ControlPerform = {};
  if (row.stop !== undefined) { if (row.stop !== true || Object.keys(row).length !== 1) throw Error("invalid stop"); return { stop: true }; }
  if (row.animation !== undefined) result.animation = text(row.animation, 160);
  if (row.text !== undefined) result.text = text(row.text, 1000);
  if (row.durationMs !== undefined) result.durationMs = number(row.durationMs, 1000, 30_000);
  if (!result.animation && !result.text || result.durationMs !== undefined && !result.text) throw Error("empty performance");
  return bounded(result);
}
export function parseControlStage(value: unknown): ControlStage {
  const row = object(value, ["position", "scale", "pointerEnabled"]), result: ControlStage = {};
  if (row.position !== undefined) {
    const position = object(row.position, ["x", "y"]);
    result.position = { x: number(position.x, 0, 1), y: number(position.y, 0, 1) };
  }
  if (row.scale !== undefined) result.scale = number(row.scale, .5, 1.5);
  if (row.pointerEnabled !== undefined) result.pointerEnabled = boolean(row.pointerEnabled);
  if (!Object.keys(result).length) throw Error("empty stage");
  return result;
}
export function parseControlFrame(value: unknown): ControlFrame {
  const row = object(value); version(row);
  const common = ["controlVersion", "sequence", "leaseId", "commandId", "leaseMs", "kind"];
  const envelope: ControlEnvelope = { controlVersion: 1, sequence: number(row.sequence, 0, Number.MAX_SAFE_INTEGER), leaseId: ref(row.leaseId), commandId: ref(row.commandId), leaseMs: number(row.leaseMs, CONTROL_LEASE_MS, CONTROL_LEASE_MS) };
  if (!Number.isSafeInteger(envelope.sequence)) throw Error("invalid sequence");
  let result: ControlFrame;
  if (row.kind === "acquire") { keys(row, [...common, "sessionTitle"]); result = { ...envelope, kind: "acquire", sessionTitle: text(row.sessionTitle, 120) }; }
  else if (row.kind === "perform") { keys(row, [...common, "animation", "text", "durationMs", "stop"]); result = { ...envelope, kind: "perform", ...parseControlPerform(without(row, common)) }; }
  else if (row.kind === "stage") { keys(row, [...common, "position", "scale", "pointerEnabled"]); result = { ...envelope, kind: "stage", ...parseControlStage(without(row, common)) }; }
  else if (row.kind === "cancel") { keys(row, [...common, "targetId"]); result = { ...envelope, kind: "cancel", targetId: ref(row.targetId) }; }
  else if (row.kind === "release") { keys(row, [...common, "reason"]); result = { ...envelope, kind: "release", reason: choice(row.reason, CONTROL_RELEASE_REASONS) }; }
  else throw Error("invalid control kind");
  return bounded(result);
}
export function parseControlAck(value: unknown): ControlAck {
  const row = object(value, ["controlVersion", "leaseId", "commandId", "status", "reason"]); version(row);
  return { controlVersion: 1, leaseId: ref(row.leaseId), commandId: ref(row.commandId), status: choice(row.status, ["started", "completed", "interrupted", "stopped", "rejected"] as const),
    ...(row.reason === undefined ? {} : { reason: choice(row.reason, ["unavailable", "unknown-animation", "user-preference", "stale", "failed"] as const) }) };
}
export function parseControlRelease(value: unknown): ControlRelease {
  const row = object(value, ["leaseId", "reason"]);
  return { leaseId: ref(row.leaseId), reason: choice(row.reason, ["user", "model-changed", "unavailable"] as const) };
}
function object(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid control object");
  const row = value as Record<string, unknown>; if (allowed) keys(row, allowed); return row;
}
function keys(row: Record<string, unknown>, allowed: string[]): void { if (Object.keys(row).some(key => !allowed.includes(key))) throw Error("unknown control field"); }
function without(row: Record<string, unknown>, omitted: string[]): Record<string, unknown> { return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.includes(key))); }
function version(row: Record<string, unknown>): void { if (row.controlVersion !== 1) throw Error("invalid control version"); }
function ref(value: unknown): string { if (!isOpaqueRef(value)) throw Error("invalid control reference"); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw Error("invalid control flag"); return value; }
function number(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw Error("invalid control number"); return value; }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== "string" || !values.includes(value as T)) throw Error("invalid control choice"); return value as T; }
function text(value: unknown, max: number): string {
  // Plain text only; retain line breaks but exclude terminal and bidi controls.
  // oxlint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw Error("invalid control text");
  return value;
}
function bounded<T>(value: T): T { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CONTROL_BYTES) throw Error("control exceeds wire limit"); return value; }
