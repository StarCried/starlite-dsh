import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { startStatusServer } from "../src/server.js";
import { SessionControl } from "../src/session-control.js";
import { DshStateAggregator } from "../src/aggregator.js";
import { QuestionBridge } from "../src/questions.js";
import type { ControlFrame } from "@starcried/starlite-dsh-protocol";

it("authenticates control transport, delegates questions during ownership, and never replays commands", async () => {
  const source = new DshStateAggregator(), questions = new QuestionBridge(source, async () => undefined), control = new SessionControl();
  const enabled = vi.spyOn(questions, "setEnabled"), server = await startStatusServer(source, { questions, control });
  const origin = `http://127.0.0.1:${server.port}`, headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, abort = new AbortController();
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const report = { controlVersion: 1, enabled: true, available: true, model: { revision: randomUUID(), title: "Model", animations: [{ name: "Wave", durationMs: 3000 }] }, preferences: { bubblesVisible: true, pointerEnabled: true, scale: 1 } };
  const stream = await fetch(`${origin}/v1/events`, { headers, signal: abort.signal }), reader = stream.body!.getReader(); await reader.read();
  const nextFrame = async (): Promise<ControlFrame> => {
    let text = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) throw Error("stream closed"); text += new TextDecoder().decode(chunk.value); const event = text.match(/event: control\ndata: ([^\n]+)/u)?.[1]; if (event) return JSON.parse(event) as ControlFrame; }
  };
  try {
    expect((await post("/v1/control/desktop", report, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("/v1/control/desktop", report, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/v1/control/desktop", { ...report, session: "forged" })).status).toBe(409);
    expect((await post("/v1/control/desktop", report)).status).toBe(204);
    await post("/v1/interaction/availability", { enabled: true }); expect(enabled).toHaveBeenLastCalledWith(true);
    const session = {}, pending = control.acquire(session, "Session", new AbortController().signal), frame = await nextFrame();
    expect(frame.kind).toBe("acquire"); expect(enabled).toHaveBeenLastCalledWith(false);
    await post("/v1/interaction/availability", { enabled: true }); expect(enabled).toHaveBeenLastCalledWith(false);
    expect((await post("/v1/control/ack", { controlVersion: 1, leaseId: frame.leaseId, commandId: frame.commandId, status: "completed" })).status).toBe(204);
    expect(await pending).toEqual({ status: "completed" });
    expect((await post("/v1/control/release", { leaseId: randomUUID(), reason: "user" })).status).toBe(204); expect(control.active).toBe(true);
    await post("/v1/control/release", { leaseId: frame.leaseId, reason: "user" }); expect(control.active).toBe(false); expect(enabled).toHaveBeenLastCalledWith(true);
    const second = control.acquire(session, "Session", new AbortController().signal); await nextFrame();
    abort.abort(); await reader.cancel().catch(() => undefined);
    expect(await second).toMatchObject({ status: "interrupted", reason: "disconnected" }); expect(control.enabled).toBe(false);
  } finally { abort.abort(); await reader.cancel().catch(() => undefined); await server.close(); }
});
