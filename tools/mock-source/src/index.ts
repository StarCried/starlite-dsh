import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  PET_PROTOCOL_VERSION,
  type PetSnapshot,
  type PetState,
  type PetStateSource,
} from "@starcried/starlite-dsh-protocol";
import { buildConnectionUrl } from "../../../packages/dsh-plugin/src/launcher.js";
import { startStatusServer } from "../../../packages/dsh-plugin/src/server.js";

const STEP_MS = 2_500;
const sequence: ReadonlyArray<{ state: PetState; text?: string }> = [
  { state: "idle" },
  { state: "thinking", text: "正在分析模型动画…" },
  { state: "working", text: "正在使用 mock_tool…" },
  { state: "approval", text: "等待批准：mock_tool" },
  { state: "completed", text: "模拟任务已完成" },
  { state: "error", text: "发生错误，请查看 DSH" },
  { state: "blocked", text: "任务被阻塞，请查看 DSH" },
];

class MockPetStateSource implements PetStateSource {
  #timer: ReturnType<typeof setInterval> | undefined;
  #sequence = 0;
  #index = 0;

  async start(emit: (snapshot: PetSnapshot) => void): Promise<void> {
    const publish = () => {
      const item = sequence[this.#index] ?? sequence[0]!;
      emit({
        protocolVersion: PET_PROTOCOL_VERSION,
        sequence: this.#sequence++,
        emittedAt: Date.now(),
        state: item.state,
        ...(item.text ? { bubble: { kind: "notice" as const, text: item.text } } : {}),
      });
      this.#index = (this.#index + 1) % sequence.length;
    };
    publish();
    this.#timer = setInterval(publish, STEP_MS);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

const server = await startStatusServer(new MockPetStateSource());
const url = buildConnectionUrl({
  port: server.port,
  token: server.token,
  instanceId: randomUUID(),
});
const executable = process.env.DSH_INOCHI2D_PET_EXE || "explorer.exe";
const child = spawn(executable, [url], {
  shell: false,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();
console.log(`Mock state source listening on 127.0.0.1:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
