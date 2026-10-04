import { describe, expect, it } from "vitest";
import type { PetSnapshot } from "../src/vendor-types.js";
import { renderBubble } from "../src/pet.js";

function element(): HTMLOutputElement {
  return { hidden: true, textContent: "" } as HTMLOutputElement;
}

function snapshot(state: PetSnapshot["state"], text?: string): PetSnapshot {
  return {
    protocolVersion: 1,
    sequence: 1,
    emittedAt: 1,
    state,
    ...(text ? { bubble: { kind: "response", text } } : {}),
  };
}

describe("bubble rendering", () => {
  it("uses textContent and hides idle", () => {
    const output = element();
    renderBubble(output, snapshot("completed", "<img src=x onerror=alert(1)>"), false);
    expect(output.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(output.hidden).toBe(false);
    renderBubble(output, snapshot("idle"), false);
    expect(output.hidden).toBe(true);
    expect(output.textContent).toBe("");
  });

  it("replaces streamed text in privacy mode", () => {
    const output = element();
    renderBubble(output, snapshot("thinking", "sensitive model-visible text"), true);
    expect(output.textContent).toBe("正在工作…");
  });
});
