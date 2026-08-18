import { describe, expect, it, vi } from "vitest";
import type { PetSnapshot, WidgetController } from "../src/vendor-types.js";
import type { AnimationMappings } from "../src/types.js";
import { StateAnimator } from "../src/state-animator.js";

const mappings: AnimationMappings = {
  idle: "Idle",
  thinking: "Thinking",
  working: null,
  completed: "Completed",
  error: null,
  blocked: null,
  approval: "Approval",
  click: "Click",
};

function snapshot(state: PetSnapshot["state"], sequence: number): PetSnapshot {
  return { protocolVersion: 1, sequence, emittedAt: sequence, state };
}

function harness() {
  const pending: Array<(value: "completed") => void> = [];
  const playAnimation = vi.fn(() => new Promise<"completed">((resolve) => pending.push(resolve)));
  const stopAnimation = vi.fn();
  const controller = {
    playAnimation,
    stopAnimation,
  } as unknown as WidgetController;
  return { animator: new StateAnimator(controller, mappings), playAnimation, stopAnimation, pending };
}

describe("StateAnimator", () => {
  it("uses loops only for sustained states and never falls back for disabled mappings", () => {
    const { animator, playAnimation, stopAnimation } = harness();
    animator.apply(snapshot("idle", 0));
    expect(playAnimation).toHaveBeenLastCalledWith("Idle", { mode: "loop", restart: true });
    animator.apply(snapshot("completed", 1));
    expect(playAnimation).toHaveBeenLastCalledWith("Completed", { mode: "once", restart: true });
    animator.apply(snapshot("working", 2));
    expect(stopAnimation).toHaveBeenCalledOnce();
    expect(playAnimation).toHaveBeenCalledTimes(2);
  });

  it("does not restart an animation for bubble-only snapshots", () => {
    const { animator, playAnimation } = harness();
    animator.apply(snapshot("thinking", 0));
    animator.apply({ ...snapshot("thinking", 1), bubble: { kind: "reasoning", text: "new" } });
    expect(playAnimation).toHaveBeenCalledOnce();
  });

  it("allows Click only in Idle and guards stale completion", async () => {
    const { animator, playAnimation, pending } = harness();
    animator.apply(snapshot("idle", 0));
    const click = animator.click();
    expect(playAnimation).toHaveBeenLastCalledWith("Click", { mode: "once", restart: true });
    animator.apply(snapshot("approval", 1));
    pending[1]?.("completed");
    await click;
    expect(playAnimation).toHaveBeenCalledTimes(3);
    expect(playAnimation).toHaveBeenLastCalledWith("Approval", { mode: "loop", restart: true });
  });

  it("restores Idle after a completed Click and ignores Click while busy", async () => {
    const { animator, playAnimation, pending } = harness();
    animator.apply(snapshot("idle", 0));
    const click = animator.click();
    pending[1]?.("completed");
    await click;
    expect(playAnimation).toHaveBeenLastCalledWith("Idle", { mode: "loop", restart: true });

    animator.apply(snapshot("thinking", 1));
    const calls = playAnimation.mock.calls.length;
    await animator.click();
    expect(playAnimation).toHaveBeenCalledTimes(calls);
  });
});
