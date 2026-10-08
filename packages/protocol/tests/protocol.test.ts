import { describe, expect, it } from "vitest";

import {
  MAX_WIRE_BYTES,
  parsePetSnapshot,
  parsePetSnapshotJson,
  parsePetConnectionUrl,
  sanitizeBubbleText,
} from "../src/index.js";

describe("sanitizeBubbleText", () => {
  it("removes ANSI/control data and produces one plain-text line", () => {
    expect(
      sanitizeBubbleText("\u001b[31mhello\u001b[0m\n\tworld\u0000"),
    ).toBe("hello world");
  });

  it("keeps the prefix and reserves one Unicode grapheme for an ellipsis", () => {
    expect(sanitizeBubbleText("A👩‍💻BC", 3)).toBe("A👩‍💻…");
    expect(sanitizeBubbleText("A👩‍💻B", 3)).toBe("A👩‍💻B");
    expect(sanitizeBubbleText("AB", 1)).toBe("…");
    expect(sanitizeBubbleText("A👩‍💻…", 3)).toBe("A👩‍💻…");
  });

  it("bounds work for unexpectedly large visible output", () => {
    const result = sanitizeBubbleText(`${"x".repeat(1_000_000)}TAIL`);
    expect([...result]).toHaveLength(120);
    expect(result).toBe(`${"x".repeat(119)}…`);
  });

  it("rejects invalid inputs and unreasonable limits", () => {
    expect(sanitizeBubbleText({ secret: true })).toBe("");
    expect(sanitizeBubbleText("text", 0)).toBe("");
    expect(sanitizeBubbleText("text", 501)).toBe("");
  });
});

describe("parsePetConnectionUrl", () => {
  const token = "a".repeat(43);
  const instance = "15c3a508-c0c7-4a6e-8c89-985e13ef5a72";

  it("accepts only the fixed connect descriptor", () => {
    expect(parsePetConnectionUrl(
      `dsh-inochi2d-pet://connect?port=4192&token=${token}&instance=${instance}`,
    )).toEqual({ port: 4192, token, instanceId: instance });
  });

  it.each([
    "https://connect/?port=4192",
    `dsh-inochi2d-pet://other?port=4192&token=${token}&instance=${instance}`,
    `dsh-inochi2d-pet://connect?port=0&token=${token}&instance=${instance}`,
    `dsh-inochi2d-pet://connect?port=4192&token=short&instance=${instance}`,
    `dsh-inochi2d-pet://connect?port=4192&token=${token}&instance=${instance}&extra=x`,
  ])("rejects %s", (value) => {
    expect(() => parsePetConnectionUrl(value)).toThrow();
  });
});

describe("parsePetSnapshot", () => {
  const valid = {
    protocolVersion: 1,
    sequence: 4,
    emittedAt: 1_000,
    state: "thinking",
    bubble: { kind: "reasoning", text: "checking types" },
  };

  it("accepts and canonicalizes a protocol-v1 frame", () => {
    expect(parsePetSnapshot(valid)).toEqual(valid);
  });

  it("rejects invalid versions, states, sequences, and bubbles", () => {
    expect(() => parsePetSnapshot({ ...valid, protocolVersion: 2 })).toThrow(
      /version/u,
    );
    expect(() => parsePetSnapshot({ ...valid, state: "secret" })).toThrow(
      /state/u,
    );
    expect(() => parsePetSnapshot({ ...valid, sequence: -1 })).toThrow(
      /sequence/u,
    );
    expect(() =>
      parsePetSnapshot({ ...valid, bubble: { kind: "tool", text: "\u0000" } }),
    ).toThrow(/bubble/u);
  });

  it("enforces a small cross-process payload", () => {
    const oversized = JSON.stringify({ value: "x".repeat(MAX_WIRE_BYTES) });
    expect(() => parsePetSnapshotJson(oversized)).toThrow(/wire limit/u);
  });
});
