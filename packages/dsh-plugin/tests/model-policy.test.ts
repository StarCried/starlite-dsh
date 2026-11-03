import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { defaultModelToAcquire } from "../src/launcher.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("starlite-model-policy-")) throw new Error("unsafe test directory");
    await rm(root, {recursive:true,force:true});
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "starlite-model-policy-"));
  roots.push(root);
  return join(root, "settings.json");
}

it("honors the persisted opt-out while enabling fresh and legacy companion settings", async () => {
  const path = await fixture();
  expect(await defaultModelToAcquire(path)).toBe("weiguang-default");
  for (const preferences of [{fps:60}, {modelEnabled:true}, {modelEnabled:false}]) {
    await writeFile(path, JSON.stringify({schemaVersion:3,preferences,privateValue:"never returned"}));
    expect(await defaultModelToAcquire(path)).toBe(preferences.modelEnabled !== false ? "weiguang-default" : null);
  }
});

it("does not fetch a character based on malformed, oversized or non-file settings", async () => {
  const path = await fixture();
  for (const contents of ["invalid json", "[]", "null", Buffer.alloc(4 * 1024 * 1024 + 1, 65)]) {
    await writeFile(path, contents);
    expect(await defaultModelToAcquire(path)).toBe(null);
  }
  await rm(path);
  await mkdir(path);
  expect(await defaultModelToAcquire(path)).toBe(null);
});

it("does not interpret malformed model flags as permission to download the character", async () => {
  const path = await fixture();
  for (const modelEnabled of ["false", null, 0, {}]) {
    await writeFile(path, JSON.stringify({preferences:{modelEnabled}}));
    expect(await defaultModelToAcquire(path)).toBe(null);
  }
});

it("only acquires the starter when selected, preserving removal and custom model selection", async () => {
  const path = await fixture();
  for (const activeModelId of ["weiguang-default", "bluefish-default"]) {
    await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId,models:[]}));
    expect(await defaultModelToAcquire(path)).toBe(activeModelId);
  }
  for (const activeModelId of [null, "custom-model", "", false, {}, "a".repeat(129), "unsafe\nvalue"]) {
    await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId,preferences:{modelEnabled:true}}));
    expect(await defaultModelToAcquire(path)).toBe(null);
  }
  for (const value of [{schemaVersion:4}, {schemaVersion:99,activeModelId:"weiguang-default"}]) {
    await writeFile(path, JSON.stringify(value));
    expect(await defaultModelToAcquire(path)).toBe(null);
  }
});

it.each(["weiguang-default", "bluefish-default"])("does not reacquire an installed %s after a program upgrade", async activeModelId => {
  const path = await fixture();
  const models = [null, {id:"other-model"}, {id:activeModelId,backend:"vrm",modelPath:"native-owned/model.vrm"}];
  await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId,models}));
  expect(await defaultModelToAcquire(path)).toBeNull();
  // Selecting a different, not-yet-imported example still acquires that example.
  const otherId = activeModelId === "weiguang-default" ? "bluefish-default" : "weiguang-default";
  await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId:otherId,models}));
  expect(await defaultModelToAcquire(path)).toBe(otherId);
});
