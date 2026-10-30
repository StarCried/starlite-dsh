import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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

it.each(["BUNDLED_MOTIONS.md", "BUNDLED_MOTIONS.json"])("requires verified motion provenance %s in the embedded runtime", async notice => {
  const root = await mkdtemp(resolve(tmpdir(), "starlite-runtime-")); temporary.push(root);
  const files = {};
  for (const name of ["index.js", "widget.css", "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt", "BUNDLED_MOTIONS.md", "BUNDLED_MOTIONS.json"]) {
    const content = `artwork-free fixture: ${name}`;
    await writeFile(resolve(root, name), content);
    files[name] = createHash("sha256").update(content).digest("hex");
  }
  const metadata = { schemaVersion: 2, package: "@starcried/starlite-vrm", files };
  const manifest = resolve(root, "runtime-provenance.json");
  await writeFile(manifest, JSON.stringify(metadata));
  await expect(assertRuntime("vrm", root)).resolves.toBeUndefined();
  await writeFile(resolve(root, notice), "changed provenance");
  await expect(assertRuntime("vrm", root)).rejects.toThrow(`artifact hash mismatch: ${notice}`);
  delete files[notice];
  await writeFile(manifest, JSON.stringify(metadata));
  await expect(assertRuntime("vrm", root)).rejects.toThrow(`unhashed vrm artifact: ${notice}`);
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
