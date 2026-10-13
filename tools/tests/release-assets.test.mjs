import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkProgramAssets } from "../release-assets.mjs";
const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "dsh-program-assets-"))) throw Error("unsafe temporary directory");
    await rm(path, {recursive:true, force:true});
  }
});
it("permits ordinary runtime resources and no optional model directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-program-assets-")); temporary.push(root);
  await mkdir(resolve(root,"apps/desktop/public/runtime"), {recursive:true});
  await writeFile(resolve(root,"apps/desktop/public/runtime/index.js"), "synthetic");
  expect(await checkProgramAssets(root)).toEqual([]);
});
it("rejects stale Inochi2D resources and WASM in source and built program assets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-program-assets-")); temporary.push(root);
  const paths = ["apps/desktop/public/runtime/inochi2d/index.js", "apps/desktop/dist/runtime/inochi2d-web/index.js", "apps/desktop/public/runtime/unexpected/runtime.wasm"];
  for (const path of paths) { await mkdir(dirname(resolve(root,path)),{recursive:true}); await writeFile(resolve(root,path), "synthetic"); }
  const failures = await checkProgramAssets(root);
  expect(failures).toHaveLength(3);
  expect(failures.join("\n")).toContain("public/runtime/inochi2d");
  expect(failures.join("\n")).toContain("dist/runtime/inochi2d-web");
  expect(failures.join("\n")).toContain("unexpected/runtime.wasm");
});
it("rejects ignored nested character files in every installer resource location", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-program-assets-")); temporary.push(root);
  const paths = ["apps/desktop/public/forgotten/Model.VRM", "apps/desktop/dist/motions/Idle.vrma", "apps/desktop/src-tauri/resources/private/model.inp"];
  for (const path of paths) { await mkdir(dirname(resolve(root,path)),{recursive:true}); await writeFile(resolve(root,path), "synthetic"); }
  const failures = await checkProgramAssets(root);
  expect(failures).toHaveLength(3);
  for (const path of paths) expect(failures).toContain(`separately licensed character asset in program resources: ${path}`);
});
