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
    renderBubble(output, snapshot("completed", "<img src=x onerror=alert(1)>"), false,"detailed");
    expect(output.querySelector(".bubble-content")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(output.firstElementChild?.textContent).toBe("DSH 会话");
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
    expect(output.textContent).toBe("DSH思考中");
    expect(output.dataset.bubbleKind).toBe("notice");
  });

  it("changes reasoning to response styling without accumulating text containers", () => {
    const output = element();
    renderBubble(output, {...snapshot("thinking", "正在核对…"), bubble:{kind:"reasoning",text:"正在核对…"}}, false,"detailed");
    expect(output.dataset.bubbleKind).toBe("reasoning");
    for(let i=0;i<20;i++)renderBubble(output,snapshot("working",`回答 ${i}`),false,"detailed");
    expect(output.dataset.bubbleKind).toBe("response");
    expect(output.querySelectorAll(".bubble-content")).toHaveLength(1);
    expect(output.querySelector(".bubble-content")?.textContent).toBe("回答 19");
  });
  it("defaults to two compact lines with exact title and fixed activity",()=>{
    const output=element();renderBubble(output,{...snapshot("working","PRIVATE content"),session:{ref:"123e4567-e89b-42d3-a456-426614174000",title:"当前会话"},activity:"command"},false);
    expect(output.querySelector(".bubble-title")?.textContent).toBe("当前会话");expect(output.querySelector(".bubble-content")?.textContent).toBe("运行命令");expect(output.children).toHaveLength(2);expect(output.textContent).not.toContain("PRIVATE");
  });
});
