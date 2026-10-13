import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { shouldAcquireDefaultModel } from "../src/launcher.js";

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
  expect(await shouldAcquireDefaultModel(path)).toBe(true);
  for (const preferences of [{fps:60}, {modelEnabled:true}, {modelEnabled:false}]) {
    await writeFile(path, JSON.stringify({schemaVersion:3,preferences,privateValue:"never returned"}));
    expect(await shouldAcquireDefaultModel(path)).toBe(preferences.modelEnabled !== false);
  }
});

it("does not fetch a character based on malformed, oversized or non-file settings", async () => {
  const path = await fixture();
  for (const contents of ["invalid json", "[]", "null", Buffer.alloc(4 * 1024 * 1024 + 1, 65)]) {
    await writeFile(path, contents);
    expect(await shouldAcquireDefaultModel(path)).toBe(false);
  }
  await rm(path);
  await mkdir(path);
  expect(await shouldAcquireDefaultModel(path)).toBe(false);
});

it("does not interpret malformed model flags as permission to download the character", async () => {
  const path = await fixture();
  for (const modelEnabled of ["false", null, 0, {}]) {
    await writeFile(path, JSON.stringify({preferences:{modelEnabled}}));
    expect(await shouldAcquireDefaultModel(path)).toBe(false);
  }
});

it("uses the library selection and never downloads for an intentionally hidden model", async () => {
  const path = await fixture();
  for (const activeModelId of ["weiguang-default", "custom-model"]) {
    await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId,models:[]}));
    expect(await shouldAcquireDefaultModel(path)).toBe(true);
  }
  for (const activeModelId of [null, "", false, {}, "a".repeat(129), "unsafe\nvalue"]) {
    await writeFile(path, JSON.stringify({schemaVersion:4,activeModelId,preferences:{modelEnabled:true}}));
    expect(await shouldAcquireDefaultModel(path)).toBe(false);
  }
  for (const value of [{schemaVersion:4}, {schemaVersion:99,activeModelId:"weiguang-default"}]) {
    await writeFile(path, JSON.stringify(value));
    expect(await shouldAcquireDefaultModel(path)).toBe(false);
  }
});
