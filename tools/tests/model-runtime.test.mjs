import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIMES, assertRuntime, assertRuntimeLayout } from "../model-runtime.mjs";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "starlite-runtime-"))) throw Error("unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
});

it("stages only the public core and VRM backend", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "starlite-runtime-")); temporary.push(root);
  for (const name of RUNTIMES) await mkdir(resolve(root, name));
  await expect(assertRuntimeLayout(root)).resolves.toBeUndefined();
  await mkdir(resolve(root, "inochi2d"));
  await expect(assertRuntimeLayout(root)).rejects.toThrow("unsupported staged runtime: inochi2d");
  await expect(assertRuntime("inochi2d", root)).rejects.toThrow("unsupported runtime");
});

it("rejects stray staged files instead of letting stale runtime bytes ship", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "starlite-runtime-")); temporary.push(root);
  await writeFile(resolve(root, "runtime.wasm"), "synthetic");
  await expect(assertRuntimeLayout(root)).rejects.toThrow("unsupported staged runtime: runtime.wasm");
});
