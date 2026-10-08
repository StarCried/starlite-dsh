import { afterEach, describe, expect, it, vi } from "vitest";
import type { PetSnapshot, WidgetController } from "../src/vendor-types.js";
import type { AnimationMappings } from "../src/types.js";
import { StateAnimator } from "../src/state-animator.js";

const mappings: AnimationMappings = {
  idle: "Idle",
  working: "Working",
  completed: "Completed",
  error: null,
  blocked: null,
  approval: "Approval",
  click: ["Click"],
  ambient: [],
};

function snapshot(state: PetSnapshot["state"], sequence: number): PetSnapshot {
  return { protocolVersion: 1, sequence, emittedAt: sequence, state };
}

function harness(config: AnimationMappings = mappings) {
  const pending: Array<(value: "completed") => void> = [];
  const playAnimation = vi.fn<WidgetController["playAnimation"]>(() => new Promise<"completed">((resolve) => pending.push(resolve)));
  const stopAnimation = vi.fn();
  const controller = {
    playAnimation,
    stopAnimation,
  } as unknown as WidgetController;
  return { animator: new StateAnimator(controller, config), playAnimation, stopAnimation, pending };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("StateAnimator", () => {
  it("merges thinking and working without restarting their shared clip", () => {
    const { animator, playAnimation } = harness();
    animator.apply(snapshot("thinking", 0));
    animator.apply(snapshot("working", 1));
    animator.apply(snapshot("thinking", 2));
    expect(playAnimation).toHaveBeenCalledOnce();
    expect(playAnimation).toHaveBeenLastCalledWith("Working", { mode: "once", restart: true });
  });

  it("samples a click pool anew on every trigger", async () => {
    const { animator, playAnimation, pending } = harness({...mappings,click:["Click","Wave"]});
    vi.spyOn(Math,"random").mockReturnValueOnce(0).mockReturnValueOnce(.99);
    animator.apply(snapshot("idle",0));
    const first=animator.click();pending[1]?.("completed");await first;
    const second=animator.click();pending[3]?.("completed");await second;
    expect(playAnimation.mock.calls.map(call => call[0])).toEqual(["Idle","Click","Idle","Wave","Idle"]);
    animator.disconnected();
  });

  it("defers ambient while paused and discards stale completion after working", async () => {
    vi.useFakeTimers();vi.spyOn(Math,"random").mockReturnValue(0);
    const { animator, playAnimation, pending } = harness({...mappings,ambient:["Yawn"]});
    animator.apply(snapshot("idle",0));animator.setPaused(true);
    await vi.advanceTimersByTimeAsync(120_000);expect(playAnimation).toHaveBeenCalledOnce();
    animator.setPaused(false);await vi.advanceTimersByTimeAsync(60_000);
    expect(playAnimation).toHaveBeenLastCalledWith("Yawn",{mode:"once",restart:true});
    animator.apply(snapshot("working",1));pending[1]?.("completed");await Promise.resolve();
    expect(playAnimation).toHaveBeenLastCalledWith("Working",{mode:"once",restart:true});
    animator.disconnected();expect(vi.getTimerCount()).toBe(0);
  });

  it("loops only Idle and stays neutral for disabled mappings", () => {
    const { animator, playAnimation, stopAnimation } = harness();
    animator.apply(snapshot("idle", 0));
    expect(playAnimation).toHaveBeenLastCalledWith("Idle", { mode: "loop", restart: false });
    animator.apply(snapshot("completed", 1));
    expect(playAnimation).toHaveBeenLastCalledWith("Completed", { mode: "once", restart: true });
    animator.apply(snapshot("blocked", 2));
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
    expect(playAnimation).toHaveBeenLastCalledWith("Approval", { mode: "once", restart: true });
  });

  it("restores Idle after a completed Click and ignores Click while busy", async () => {
    const { animator, playAnimation, pending } = harness();
    animator.apply(snapshot("idle", 0));
    const click = animator.click();
    pending[1]?.("completed");
    await click;
    expect(playAnimation).toHaveBeenLastCalledWith("Idle", { mode: "loop", restart: false });

    animator.apply(snapshot("thinking", 1));
    const calls = playAnimation.mock.calls.length;
    await animator.click();
    expect(playAnimation).toHaveBeenCalledTimes(calls);
  });

  it("finishes a short work gesture after the logical state has already returned to Idle", async () => {
    const {animator,playAnimation,pending}=harness();
    animator.apply(snapshot("working",0));animator.apply(snapshot("idle",1));
    expect(playAnimation).toHaveBeenCalledOnce();await animator.click();
    expect(playAnimation).toHaveBeenCalledOnce();
    pending[0]?.("completed");await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenLastCalledWith("Idle",{mode:"loop",restart:false});
  });

  it("plays each work state once, returns to Idle and still blocks clicks while logically busy",async()=>{
    const {animator,playAnimation,pending}=harness();
    animator.apply(snapshot("working",0));pending[0]?.("completed");
    await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenLastCalledWith("Idle",{mode:"loop",restart:false});
    await animator.click();animator.apply(snapshot("working",1));
    expect(playAnimation).toHaveBeenCalledTimes(2);
  });

  it.each(["blocked", "error", "approval", "completed"] as const)("immediately replaces work with %s and ignores the obsolete completion",async(state)=>{
    const {animator,playAnimation,pending}=harness({...mappings,blocked:"Blocked",error:"Error"});
    animator.apply(snapshot("working",0));animator.apply(snapshot(state,1));
    const name={blocked:"Blocked",error:"Error",approval:"Approval",completed:"Completed"}[state];
    expect(playAnimation).toHaveBeenCalledTimes(2);
    expect(playAnimation).toHaveBeenLastCalledWith(name,{mode:"once",restart:true});
    pending[0]?.("completed");await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenCalledTimes(2);
    pending[1]?.("completed");await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenLastCalledWith("Idle",{mode:"loop",restart:false});
  });

  it("keeps rapid state changes current when obsolete completions arrive out of order",async()=>{
    const {animator,playAnimation,pending}=harness();
    animator.apply(snapshot("working",0));animator.apply(snapshot("completed",1));animator.apply(snapshot("approval",2));
    expect(playAnimation.mock.calls.map(call=>call[0])).toEqual(["Working","Completed","Approval"]);
    pending[1]?.("completed");pending[0]?.("completed");
    await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenCalledTimes(3);
    expect(playAnimation).toHaveBeenLastCalledWith("Approval",{mode:"once",restart:true});
    pending[2]?.("completed");await Promise.resolve();await Promise.resolve();
    expect(playAnimation).toHaveBeenLastCalledWith("Idle",{mode:"loop",restart:false});
  });

  it("ignores repeated clicks while the current response finishes",async()=>{
    const {animator,playAnimation,pending}=harness();
    animator.apply(snapshot("idle",0));const first=animator.click();await animator.click();
    expect(playAnimation).toHaveBeenCalledTimes(2);pending[1]?.("completed");await first;
    expect(playAnimation).toHaveBeenCalledTimes(3);
  });

  it("does not resume Idle after disconnection or a disabled mapping cancels a state",async()=>{
    const {animator,playAnimation,pending,stopAnimation}=harness();
    animator.apply(snapshot("working",0));animator.apply(snapshot("blocked",1));pending[0]?.("completed");
    await Promise.resolve();await Promise.resolve();expect(playAnimation).toHaveBeenCalledOnce();
    animator.apply(snapshot("approval",2));animator.disconnected();pending[1]?.("completed");
    await Promise.resolve();await Promise.resolve();expect(playAnimation).toHaveBeenCalledTimes(2);expect(stopAnimation).toHaveBeenCalledTimes(2);
  });
});
