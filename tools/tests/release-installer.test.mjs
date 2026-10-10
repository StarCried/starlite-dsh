import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkReleaseInstaller, INSTALLER_INPUTS } from "../release-installer.mjs";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "dsh-release-installer-"))) throw Error("unsafe temporary directory");
    await rm(path, {recursive: true, force: true});
  }
});
const installer = "apps/desktop/src-tauri/target/release/bundle/nsis/DSH Companion_0.1.0-alpha.0_x64-setup.exe";
async function file(root, relativePath, time, content = "synthetic build input") {
  const path = resolve(root, relativePath);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content);
  await utimes(path, time, time);
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-release-installer-")); temporary.push(root);
  await file(root, installer, 2000);
  return root;
}

it("rejects old versions and retired product names even when an installer exists", async () => {
  const root = await fixture();
  expect(await checkReleaseInstaller(root, "DSH Companion", "0.1.0-alpha.1", [])).toHaveLength(1);
  expect(await checkReleaseInstaller(root, "DSH Inochi2D Pet", "0.1.0-alpha.0", [])).toHaveLength(1);
});
it("rejects an empty current installer", async () => {
  const root = await fixture(); await file(root, installer, 2000, "");
  expect(await checkReleaseInstaller(root, "DSH Companion", "0.1.0-alpha.0", [])).toHaveLength(1);
});
it("rejects changes to frontend, native, dependencies and runtime contents", async () => {
  const root = await fixture();
  const changed = ["apps/desktop/src/pet.ts", "apps/desktop/src-tauri/src/hit_test.rs", "pnpm-lock.yaml", "apps/desktop/public/runtime/vrm-web/index.js"];
  for (const path of changed) await file(root, path, 3000);
  const failures = await checkReleaseInstaller(root, "DSH Companion", "0.1.0-alpha.0", ["apps/desktop/src", "apps/desktop/src-tauri/src", "pnpm-lock.yaml", "apps/desktop/public/runtime"]);
  expect(failures).toHaveLength(changed.length);
  for (const path of changed) expect(failures).toContain(`the NSIS installer is older than release input: ${path}`);
});
it("accepts inputs older than the current installer but rejects missing build inputs", async () => {
  const root = await fixture(); await file(root, "apps/desktop/src/pet.ts", 1000);
  expect(await checkReleaseInstaller(root, "DSH Companion", "0.1.0-alpha.0", ["apps/desktop/src"])).toEqual([]);
  expect(await checkReleaseInstaller(root, "DSH Companion", "0.1.0-alpha.0", ["apps/desktop/src-tauri/Cargo.lock"])).toEqual(["release build input is missing or unsafe: apps/desktop/src-tauri/Cargo.lock"]);
});
it("covers native packaging, desktop permissions, sources and locked dependencies", () => {
  for (const path of ["pnpm-lock.yaml", "packages/protocol/src", "apps/desktop/src", "apps/desktop/public/runtime", "apps/desktop/src-tauri/src", "apps/desktop/src-tauri/capabilities", "apps/desktop/src-tauri/Cargo.lock", "apps/desktop/src-tauri/tauri.conf.json"]) expect(INSTALLER_INPUTS).toContain(path);
});
