import { describe, expect, it, vi } from "vitest";
import type { PetSnapshot, PetStateSource } from "@dsh-inochi2d-pet/protocol";
import { startDshAdapter, type CordisContextLike } from "../src/adapter.js";
import type { BillingSource } from "../src/billing.js";

describe("DSH compatibility adapter", () => {
  it("enables native billing immediately when DSH saves a credential after startup", async () => {
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    let configured = false;
    let billing: BillingSource | undefined;
    const request = vi.fn(async () => new Response(JSON.stringify({is_available:true,balance_infos:[{currency:"CNY",total_balance:"12.34"}]}),{headers:{"Content-Type":"application/json"}}));
    const services: Record<string,unknown> = {
      settings:{get:(namespace:string) => namespace === "llm-deepseek" ? {apiKeyEnv:"DEEPSEEK_API_KEY",baseURL:"https://api.deepseek.com"} : undefined},
      credentials:{resolve:async () => configured ? {value:"PRIVATE-key"} : undefined},
    };
    vi.stubGlobal("fetch",request);
    let stop: (() => void | Promise<void>) | undefined;
    try {
      stop = await startDshAdapter({get:name => services[name],on(event,listener){listeners.set(event,listener);return () => listeners.delete(event);}}, {
        isWsl:() => true,
        startServer:async (_source,options) => {billing = options?.billing;return {port:41234,token:"a".repeat(43),close:async()=>undefined};},
        launch:async()=>undefined,
      });
      expect((await billing!.read()).balance.status).toBe("unconfigured");
      expect(request).not.toHaveBeenCalled();
      configured = true;
      listeners.get("credentials/reference-updated")?.("DEEPSEEK_API_KEY");
      expect((await billing!.read()).balance.status).toBe("ready");
      expect(request).toHaveBeenCalledExactlyOnceWith("https://api.deepseek.com/user/balance",expect.objectContaining({method:"GET",redirect:"error"}));
    } finally {await stop?.();vi.unstubAllGlobals();}
  });
  it("subscribes without importing DSH internals and cleans up", async () => {
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    const disposed: string[] = [];
    const context: CordisContextLike = {
      on(event, listener) {
        listeners.set(event, listener);
        return () => disposed.push(event);
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    const snapshots: PetSnapshot[] = [];
    let source: PetStateSource | undefined;
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);

    const stop = await startDshAdapter(context, {
      isWsl: () => true,
      startServer: async (candidate) => {
        source = candidate;
        await candidate.start((snapshot) => snapshots.push(snapshot));
        return { port: 41234, token: "a".repeat(43), close };
      },
      launch,
    });

    const session = {};
    const agent = { session };
    listeners.get("agent/status")?.({ agent, status: "running" });
    listeners.get("session/event")?.(session, {
      type: "tool/call",
      data: { callId: "c", name: "bash", arguments: "private" },
    });
    expect(snapshots.at(-1)?.state).toBe("working");
    expect(JSON.stringify(snapshots)).not.toContain("private");
    expect(source).toBeDefined();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ port: 41234 }));

    let settleApproval: ((value: string) => void) | undefined;
    const next = vi.fn(() => new Promise<string>((resolve) => {
      settleApproval = resolve;
    }));
    const approval = listeners.get("approval/request")?.(
      { agent, toolName: "shell", reason: "private approval reason" },
      next,
    ) as Promise<unknown>;
    expect(snapshots.at(-1)?.state).toBe("approval");
    expect(JSON.stringify(snapshots)).not.toContain("private approval reason");
    settleApproval?.("approved");
    await expect(approval).resolves.toBe("approved");
    expect(snapshots.at(-1)?.state).toBe("working");
    expect(next).toHaveBeenCalledOnce();

    await stop();
    expect(close).toHaveBeenCalledOnce();
    expect(disposed).toEqual(expect.arrayContaining([
      "agent/status",
      "agent/error",
      "session/event",
      "approval/request",
    ]));
  });

  it("fails before opening the bridge outside WSL", async () => {
    const startServer = vi.fn();
    await expect(startDshAdapter({ on: vi.fn() }, {
      isWsl: () => false,
      startServer,
    })).rejects.toThrow(/WSL2/);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("receives the new live stream, resets retries, and keeps durable completion text", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    const snapshots: PetSnapshot[] = [];
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const stop = await startDshAdapter({
      on(event, listener) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    }, {
      isWsl: () => true,
      startServer: async (source) => {
        await source.start((snapshot) => snapshots.push(snapshot));
        close.mockImplementation(() => source.stop());
        return { port: 41234, token: "a".repeat(43), close };
      },
      launch: async () => undefined,
    });

    try {
      const session = { id: "PRIVATE session", cwd: "PRIVATE path" };
      const agent = { session };
      const stream = (frame: unknown) => listeners.get("agent/assistant-stream")?.({ agent, frame });
      const event = (type: string, data: unknown) => listeners.get("session/event")?.(session, { type, data });
      listeners.get("agent/status")?.({ agent, status: "running" });
      event("turn/start", { turn: 1 });
      stream({ type: "start", attemptId: "PRIVATE attempt", revision: 1, turn: 1, step: 1 });
      stream({ type: "chunk", chunk: { type: "reasoning-delta", text: "正在分析" } });
      await vi.advanceTimersByTimeAsync(200);
      expect(snapshots.at(-1)?.bubble).toEqual({ kind: "reasoning", text: "正在分析" });

      stream({ type: "chunk", chunk: { type: "text-delta", text: "未完成的回复" } });
      await vi.advanceTimersByTimeAsync(200);
      expect(snapshots.at(-1)?.bubble?.text).toBe("未完成的回复");
      stream({ type: "end", outcome: { kind: "abandoned" } });
      stream({ type: "start", revision: 2 });
      await vi.advanceTimersByTimeAsync(200);
      expect(snapshots.at(-1)?.bubble?.text).toBe("思考中…");
      stream({ type: "chunk", chunk: { type: "text-delta", text: "最终回复" } });
      for (const chunk of [
        { type: "tool-call-delta", arguments: "PRIVATE arguments", text: "PRIVATE tool text" },
        { type: "user", text: "PRIVATE prompt" },
        { type: "reasoning-delta", text: { secret: "PRIVATE object" } },
      ]) stream({ type: "chunk", chunk });
      stream(null);
      listeners.get("agent/assistant-stream")?.({ frame: { type: "chunk", chunk: { type: "text-delta", text: "PRIVATE orphan" } } });
      await vi.advanceTimersByTimeAsync(200);
      expect(snapshots.at(-1)?.bubble?.text).toBe("最终回复");

      event("assistant/message", {
        message: { content: [{ type: "text", text: "最终回复" }] },
        stream: [{ chunk: { arguments: "PRIVATE raw stream" } }],
      });
      stream({ type: "end", outcome: { kind: "committed", eventType: "assistant/message", seq: 10 } });
      event("turn/end", { reason: { kind: "completed" } });
      expect(snapshots.at(-1)?.state).toBe("completed");
      expect(snapshots.at(-1)?.bubble?.text).toBe("最终回复");
      expect(JSON.stringify(snapshots)).not.toContain("PRIVATE");
    } finally {
      await stop();
      vi.useRealTimers();
    }
    expect(close).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it("closes the bridge if a changed streaming subscription is rejected", async () => {
    const disposed: string[] = [];
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);
    await expect(startDshAdapter({
      on(event) {
        if (event === "agent/assistant-stream") throw new Error("incompatible stream subscription");
        return () => disposed.push(event);
      },
    }, {
      isWsl: () => true,
      startServer: async () => ({ port: 41234, token: "a".repeat(43), close }),
      launch,
    })).rejects.toThrow("incompatible stream subscription");
    expect(disposed).toEqual(["agent/error", "agent/status"]);
    expect(close).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });
});
