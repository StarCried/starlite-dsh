import { expect, it } from "vitest";
import { compactConstantAnimationSamples, glbWriter, hasAuthoredEyeRotation, readGlb } from "../prepare-single-vrm.mjs";

it("keeps constant rotation and multi-morph tracks at their exact endpoints", () => {
  const times = [0, 0.25, 0.5, 1];
  expect(compactConstantAnimationSamples(times, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]))
    .toEqual({ times: [0, 1], values: [0, 0, 0, 1, 0, 0, 0, 1] });
  expect(compactConstantAnimationSamples(times, [0, 0.25, 1, 0, 0.25, 1, 0, 0.25, 1, 0, 0.25, 1]))
    .toEqual({ times: [0, 1], values: [0, 0.25, 1, 0, 0.25, 1] });
  expect(compactConstantAnimationSamples(times, [0, 0, 0, 0]))
    .toEqual({ times: [0, 1], values: [0, 0] });
});

it("never reduces varying samples, including tiny changes or signed zero", () => {
  const times = [0, 0.25, 0.5, 1];
  for (const values of [[0, 0, 1e-12, 0], [0, -0, 0, 0], [0, 1, 0, 1, 0, 1.01, 0, 1]]) {
    const compact = compactConstantAnimationSamples(times, values);
    expect(compact.times).toBe(times);
    expect(compact.values).toBe(values);
  }
  expect(compactConstantAnimationSamples([2, 3], [1, 1])).toEqual({ times: [2, 3], values: [1, 1] });
});

it("rejects samples that cannot be divided into complete frames", () => {
  expect(() => compactConstantAnimationSamples([0], [1])).toThrow("sample dimensions");
  expect(() => compactConstantAnimationSamples([0, 1], [1, 2, 3])).toThrow("sample dimensions");
  expect(() => compactConstantAnimationSamples([0, 1], [])).toThrow("sample dimensions");
});

it("omits exported neutral eye channels so cursor look-at remains available", () => {
  expect(hasAuthoredEyeRotation(undefined)).toBe(false);
  expect(hasAuthoredEyeRotation({ values: [0, 0, 0, 1, 0, 0, 0, -1] })).toBe(false);
  expect(hasAuthoredEyeRotation({ values: [0, 0.2, 0, 0.98] })).toBe(true);
});

it("keeps source binary indexes intact when appending standard animation accessors", () => {
  const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 3 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3 }] };
  const original = Buffer.from([7, 8, 9]);
  const writer = glbWriter(json, original);
  const input = writer.floats([0, 1], 1, true);
  const output = writer.floats([0, 0, 0, 1, 0, 1, 0, 0], 4);
  json.animations = [{ name: "Idle", channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }],
    samplers: [{ input, output, interpolation: "LINEAR" }] }];
  const parsed = readGlb(writer.finish());
  expect(parsed.bin.subarray(0, 3)).toEqual(original);
  expect(parsed.json.bufferViews[1]).toEqual({ buffer: 0, byteOffset: 4, byteLength: 8 });
  expect(parsed.json.accessors[input]).toMatchObject({ min: [0], max: [1], type: "SCALAR", count: 2 });
  expect(parsed.json.accessors[output]).toMatchObject({ type: "VEC4", count: 2 });
  expect(parsed.bin.readFloatLE(parsed.json.bufferViews[2].byteOffset + 7 * 4)).toBe(0);
});

it("rejects external images rather than creating sidecar dependencies", () => {
  const json = { asset: { version: "2.0" }, images: [{ uri: "https://example.test/texture.png" }] };
  expect(() => readGlb(glbWriter(json, Buffer.alloc(0)).finish())).toThrow("self-contained");
});

it("rejects malformed chunk lengths and non-finite animation values", () => {
  const writer = glbWriter({ asset: { version: "2.0" } }, Buffer.alloc(0));
  expect(() => writer.floats([Number.NaN], 1)).toThrow("Invalid animation values");
  expect(() => writer.floats([1, 2, 3], 4)).toThrow("Invalid animation values");
  const bytes = writer.finish();
  bytes.writeUInt32LE(0xffffffff, 12);
  expect(() => readGlb(bytes)).toThrow("chunk length");
});
