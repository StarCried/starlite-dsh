import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetSnapshot } from "@dsh-inochi2d-pet/protocol";
import { DshStateAggregator } from "../src/aggregator.js";

describe("DshStateAggregator", () => {
  it("retains exact titles/references at idle and classifies work without arguments",async()=>{
    const snapshots:PetSnapshot[]=[],source=new DshStateAggregator();await source.start(s=>snapshots.push(s));
    const key={id:"PRIVATE"},info=source.sessionInfo(key,"测试会话");source.handleAgentStatus(key,"running");
    source.handleSessionEvent(key,{type:"tool/call",data:{callId:"x",name:"bash",arguments:"PRIVATE"}});
    expect(snapshots.at(-1)).toMatchObject({session:info,activity:"command"});
    source.handleSessionEvent(key,{type:"tool/result",data:{callId:"x"}});
    source.handleSessionEvent(key,{type:"compaction/start"});await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.activity).toBe("compacting");
    source.handleSessionEvent(key,{type:"turn/end",data:{reason:{kind:"cancelled"}}});
    expect(snapshots.at(-1)).toMatchObject({state:"idle",session:info,activity:"idle"});expect(JSON.stringify(snapshots)).not.toContain("PRIVATE");await source.stop();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("emits an initial snapshot and throttles content without delaying state changes", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));

    source.handleAgentStatus("a", "running");
    source.handleSessionEvent("a", {
      type: "assistant/chunk",
      data: { chunk: { type: "reasoning-delta", text: "正在思考" } },
    });
    expect(snapshots.map(({ state }) => state)).toEqual(["idle", "thinking"]);

    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble).toEqual({ kind: "reasoning", text: "正在思考" });

    source.handleSessionEvent("a", {
      type: "tool/call",
      data: { callId: "c1", name: "shell", arguments: "SECRET" },
    });
    expect(snapshots.at(-1)?.state).toBe("working");
    expect(JSON.stringify(snapshots)).not.toContain("SECRET");
    expect(snapshots.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
  });

  it("applies global priority across concurrent sessions", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));

    source.handleSessionEvent("completed", { type: "turn/start" });
    source.handleSessionEvent("completed", {
      type: "assistant/chunk",
      data: { chunk: { type: "text-delta", text: "低优先级完成" } },
    });
    source.handleSessionEvent("completed", {
      type: "turn/end",
      data: { reason: { kind: "completed" } },
    });
    source.handleAgentStatus("active", "running");
    expect(snapshots.at(-1)?.state).toBe("thinking");

    source.handleSessionEvent("active", {
      type: "tool/call",
      data: { callId: "c", name: "bash" },
    });
    expect(snapshots.at(-1)?.state).toBe("working");

    source.handleSessionEvent("active", {
      type: "approval/asked",
      data: { id: "p", toolName: "bash", reason: "must not cross wire" },
    });
    expect(snapshots.at(-1)?.state).toBe("approval");

    source.handleAgentError("completed");
    expect(snapshots.at(-1)?.state).toBe("error");
    expect(JSON.stringify(snapshots)).not.toContain("must not cross wire");
  });

  it("uses the most recently active session when priorities tie", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));
    source.handleAgentStatus("older", "running");
    source.handleSessionEvent("older", {
      type: "assistant/chunk",
      data: { chunk: { type: "reasoning-delta", text: "older visible text" } },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble?.text).toBe("older visible text");

    await vi.advanceTimersByTimeAsync(1);
    source.handleAgentStatus("newer", "running");
    // Bubble-only updates obey the 200 ms wire throttle even when the winning
    // session changes; state changes remain immediate.
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble?.text).toBe("思考中…");
  });

  it.each(["code", "ptc"])("tracks normal, nested %s, and question tool lifecycles", async (dialect) => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));
    source.handleSessionEvent("s", { type: "turn/start" });

    source.handleSessionEvent("s", {
      type: `tool/${dialect}-dispatch-start`,
      data: { subCallId: "nested", name: "read_file", arguments: { path: "private" } },
    });
    expect(snapshots.at(-1)?.state).toBe("working");
    source.handleSessionEvent("s", {
      type: `tool/${dialect}-dispatch-start`,
      data: { subCallId: "parallel", name: "shell", arguments: "private" },
    });
    source.handleSessionEvent("s", { type: `tool/${dialect}-dispatch`, data: { subCallId: "nested", content: "private" } });
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.state).toBe("working");
    expect(snapshots.at(-1)?.bubble?.text).toBe("正在使用 shell…");
    source.handleSessionEvent("s", { type: `tool/${dialect}-dispatch`, data: { subCallId: "parallel", content: "private" } });
    expect(snapshots.at(-1)?.state).toBe("thinking");

    source.handleSessionEvent("s", {
      type: "tool/call",
      data: { callId: "question", name: "request_user_input" },
    });
    expect(snapshots.at(-1)?.state).toBe("approval");
    source.handleSessionEvent("s", {
      type: "tool/result",
      data: { message: { source: { callId: "question" }, content: "private answer" } },
    });
    expect(snapshots.at(-1)?.state).toBe("thinking");
    expect(JSON.stringify(snapshots)).not.toContain("private");
  });

  it("latches completed and error states for their specified durations", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));

    source.handleSessionEvent("s", { type: "turn/start" });
    source.handleSessionEvent("s", {
      type: "turn/end",
      data: { reason: { kind: "completed" } },
    });
    expect(snapshots.at(-1)?.state).toBe("completed");
    await vi.advanceTimersByTimeAsync(5_999);
    expect(snapshots.at(-1)?.state).toBe("completed");
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots.at(-1)?.state).toBe("idle");

    source.handleSessionEvent("s", { type: "turn/start" });
    source.handleSessionEvent("s", {
      type: "turn/end",
      data: { reason: { kind: "error", error: { stack: "private stack" } } },
    });
    expect(snapshots.at(-1)?.state).toBe("error");
    expect(JSON.stringify(snapshots)).not.toContain("private stack");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(snapshots.at(-1)?.state).toBe("idle");
  });

  it("holds blocked until the next turn and ignores sensitive event types", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start((snapshot) => snapshots.push(snapshot));
    source.handleSessionEvent("s", {
      type: "turn/end",
      data: { reason: { kind: "blocked" } },
    });
    source.handleSessionEvent("s", { type: "user/message", data: { content: "TOP SECRET" } });
    expect(snapshots.at(-1)?.state).toBe("blocked");
    expect(JSON.stringify(snapshots)).not.toContain("TOP SECRET");
    source.handleSessionEvent("s", { type: "turn/start" });
    expect(snapshots.at(-1)?.state).toBe("thinking");
  });

  it("keeps word boundaries between streamed chunks and final content blocks", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start(snapshot => snapshots.push(snapshot));
    source.handleAgentStatus("s", "running");
    for (const [type, parts, kind] of [
      ["reasoning-delta", ["Checking ", "the", "\n\t", "model"], "reasoning"],
      ["text-delta", ["The ", "model ", "is ready."], "response"],
    ] as const) {
      for (const text of parts) source.handleAssistantStream("s", {type:"chunk", chunk:{type,text}});
      await vi.advanceTimersByTimeAsync(200);
      expect(snapshots.at(-1)?.bubble).toEqual({kind,text:kind === "reasoning" ? "Checking the model" : "The model is ready."});
    }
    source.handleSessionEvent("s", {type:"assistant/message", data:{message:{content:[
      {type:"text",text:"The model "}, {type:"text",text:"is ready."},
    ]}}});
    source.handleSessionEvent("s", {type:"turn/end", data:{reason:{kind:"completed"}}});
    expect(snapshots.at(-1)?.bubble?.text).toBe("The model is ready.");
    await source.stop();
  });

  it("preserves the bounded prefix as a long live answer continues, and clears it for a retry", async () => {
    const snapshots: PetSnapshot[] = [];
    const source = new DshStateAggregator();
    await source.start(snapshot => snapshots.push(snapshot));
    source.handleAgentStatus("s", "running");
    source.handleAssistantStream("s", {type:"chunk",chunk:{type:"text-delta",text:"旧".repeat(140)}});
    await vi.advanceTimersByTimeAsync(200);
    source.handleAssistantStream("s", {type:"chunk",chunk:{type:"text-delta",text:" 新内容"}});
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble?.text).toBe("旧".repeat(119)+"…");
    for(let i=0;i<100;i++)source.handleAssistantStream("s", {type:"chunk",chunk:{type:"text-delta",text:" 后续内容".repeat(50)}});
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble?.text).toBe("旧".repeat(119)+"…");
    source.handleAssistantStream("s", {type:"start"});
    source.handleAssistantStream("s", {type:"chunk",chunk:{type:"text-delta",text:"重试后的新回答"}});
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots.at(-1)?.bubble?.text).toBe("重试后的新回答");
    await source.stop();
  });
});
