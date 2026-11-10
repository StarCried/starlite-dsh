import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionControl } from "../src/session-control.js";
import { registerSessionTools } from "../src/session-tools.js";

type Tool = { name: string; parameters: object; output: { schema: object; render(args: unknown, value: unknown): unknown }; execute(args: unknown, exec: unknown): Promise<unknown> };
type Activation = { when(exec: unknown): boolean };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup() {
  const control = new SessionControl(), tools = new Map<string, Tool>(), gates = new Map<string, Activation>(); cleanup.push(() => control.close());
  const skillDispose = vi.fn(), skillRegister = vi.fn(() => skillDispose), credentials = vi.fn();
  const services: Record<string, unknown> = { tools: { register(tool: Tool, options: Activation) { tools.set(tool.name, tool); gates.set(tool.name, options); return () => tools.delete(tool.name); } }, skills: { register: skillRegister }, sessionTitle: { get: () => ({ title: "Private local session" }) }, credentials: { resolve: credentials } };
  cleanup.push(registerSessionTools({ get: name => services[name] }, control));
  const report = { controlVersion: 1, enabled: true, available: true, model: { revision: randomUUID(), title: "Model", animations: [{ name: "Wave", durationMs: 3000 }] }, preferences: { bubblesVisible: true, pointerEnabled: true, scale: 1 } };
  const exec = { agent: { session: { key: "secret" } }, signal: new AbortController().signal };
  control.subscribe(frame => { if (frame.kind !== "release" && frame.kind !== "cancel") control.acknowledge({ controlVersion: 1, leaseId: frame.leaseId, commandId: frame.commandId, status: "completed" }); });
  return { control, tools, gates, skillRegister, skillDispose, credentials, report, exec, call: (name: string, args: unknown, execution: unknown = exec) => tools.get(name)!.execute(args, execution) };
}
it("feature detects optional registries and rolls back partial registration", () => {
  const control = new SessionControl(); cleanup.push(() => control.close());
  expect(() => registerSessionTools({}, control)()).not.toThrow();
  const dispose = vi.fn(), warn = vi.fn(), register = vi.fn().mockReturnValueOnce(dispose).mockImplementationOnce(() => { throw Error("private detail"); });
  const unregister = registerSessionTools({ get: () => ({ register }), logger: { warn } }, control);
  control.report({ controlVersion: 1, enabled: true, available: false, preferences: { bubblesVisible: true, pointerEnabled: true, scale: 1 } });
  unregister(); expect(dispose).toHaveBeenCalledOnce(); expect(JSON.stringify(warn.mock.calls)).not.toContain("private detail");
});
it("gates every tool on desktop opt-in and loads its skill only while enabled", async () => {
  const { control, tools, gates, report, exec, call, skillRegister, skillDispose, credentials } = setup();
  expect(tools.size).toBe(0); expect(skillRegister).not.toHaveBeenCalled();
  control.setConnected(true); control.report(report);
  expect([...tools.keys()]).toEqual(["starlite_inspect", "starlite_control", "starlite_perform", "starlite_stage"]);
  expect(gates.get("starlite_control")!.when(exec)).toBe(true); expect(skillRegister).toHaveBeenCalledOnce();
  expect(skillRegister.mock.calls[0]).toEqual([expect.objectContaining({ name: "starlite-character", source: "runtime" })]);
  expect(await call("starlite_control", { action: "acquire" })).toEqual({ status: "completed" });
  expect(await call("starlite_perform", { animation: "Wave", text: "Hello" })).toEqual({ status: "completed" });
  expect(await call("starlite_stage", { position: { x: .5, y: .5 }, pointerEnabled: false })).toEqual({ status: "completed" });
  const inspected = await call("starlite_inspect", {}); expect(inspected).toMatchObject({ controlledBySelf: true }); expect(JSON.stringify(inspected)).not.toContain("secret");
  const stale = tools.get("starlite_control")!;
  control.report({ ...report, enabled: false }); expect(skillDispose).toHaveBeenCalledOnce(); expect(credentials).not.toHaveBeenCalled(); expect(tools.size).toBe(0);
  expect(await stale.execute({ action: "acquire" }, exec)).toEqual({ status: "rejected", reason: "disabled" });
  control.report(report); expect(await stale.execute({ action: "acquire" }, exec)).toEqual({ status: "rejected", reason: "stale" });
  expect(await call("starlite_control", { action: "renew" })).toMatchObject({ reason: "not-owner" });
});
it("requires SDK identity and rejects self-reported session, unknown keys and non-bound values", async () => {
  const { control, gates, report, call, exec } = setup(); control.setConnected(true); control.report(report);
  expect(gates.get("starlite_control")!.when({ signal: exec.signal })).toBe(false);
  await expect(call("starlite_control", { action: "acquire" }, { session: exec.agent.session, signal: exec.signal })).rejects.toThrow("live DSH");
  await expect(call("starlite_control", { action: "acquire", sessionId: "forged" })).rejects.toThrow("arguments");
  await expect(call("starlite_control", { action: "other" })).rejects.toThrow("action");
  await call("starlite_control", { action: "acquire" });
  expect(await call("starlite_perform", { text: "hi" }, { agent: { session: {} }, signal: exec.signal })).toMatchObject({ reason: "busy" });
  await expect(call("starlite_stage", { position: { x: 100, y: 0 } })).rejects.toThrow();
  await expect(call("starlite_perform", { stop: true, animation: "Wave" })).rejects.toThrow();
});
it("returns canonical JSON with a native output renderer", async () => {
  const { control, report, tools, call } = setup(); control.report(report); const value = await call("starlite_inspect", {});
  expect(tools.get("starlite_inspect")!.output.render({}, value)).toEqual([{ type: "text", text: JSON.stringify(value) }]);
  expect(tools.get("starlite_inspect")!.parameters).toMatchObject({ type: "object", additionalProperties: false });
});
