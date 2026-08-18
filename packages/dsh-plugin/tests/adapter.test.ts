import { describe, expect, it, vi } from "vitest";
import type { PetSnapshot, PetStateSource } from "@dsh-inochi2d-pet/protocol";
import { startDshAdapter, type CordisContextLike } from "../src/adapter.js";

describe("DSH compatibility adapter", () => {
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
});
