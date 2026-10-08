// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { PetSnapshot } from "../src/vendor-types.js";
import { renderBubble } from "../src/pet.js";

function element(): HTMLOutputElement {
  const output = document.createElement("output");
  output.hidden = true;
  return output;
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
    expect(output.dataset.bubbleKind).toBe("response");
    expect(output.querySelector("img")).toBeNull();
    renderBubble(output, snapshot("idle"), false);
    expect(output.hidden).toBe(true);
    expect(output.textContent).toBe("");
    expect(output.dataset.bubbleKind).toBeUndefined();
  });

  it("replaces streamed text in privacy mode", () => {
    const output = element();
    renderBubble(output, snapshot("thinking", "sensitive model-visible text"), true);
    expect(output.textContent).toBe("正在工作…");
    expect(output.dataset.bubbleKind).toBe("notice");
  });

  it("changes reasoning to response styling without accumulating text containers", () => {
    const output = element();
    renderBubble(output, {...snapshot("thinking", "正在核对…"), bubble:{kind:"reasoning",text:"正在核对…"}}, false);
    expect(output.dataset.bubbleKind).toBe("reasoning");
    for(let i=0;i<20;i++)renderBubble(output,snapshot("working",`回答 ${i}`),false);
    expect(output.dataset.bubbleKind).toBe("response");
    expect(output.querySelectorAll(".bubble-content")).toHaveLength(1);
    expect(output.textContent).toBe("回答 19");
  });
});
