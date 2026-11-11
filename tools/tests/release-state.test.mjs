import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertPreparedRun, checkCurrentDocs, compareVersions, CURRENT_DOCS, digest, docsOnly, integrity, registryPackage, syncVersions, verifyFiles, VERSION_FILES, writeJson } from "../release-state.mjs";

const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true}); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "starlite-release-state-")); directories.push(root);
  const file = async (name, text) => { await mkdir(dirname(join(root, name)), {recursive: true}); await writeFile(join(root, name), text); };
  await file("packages/dsh-plugin/package.json", '{"version":"0.1.2"}');
  for (const name of VERSION_FILES) await file(name, '{"version":"0.1.1"}');
  await file("apps/desktop/src-tauri/Cargo.toml", '[package]\nname = "dsh-inochi2d-pet"\nversion = "0.1.1"\n');
  await file("apps/desktop/src-tauri/Cargo.lock", '[[package]]\nname = "third-party"\nversion = "0.1.1"\n\n[[package]]\nname = "dsh-inochi2d-pet"\nversion = "0.1.1"\n');
  for (const name of CURRENT_DOCS) await file(name, "Install dsh-starlite (latest).\n");
  return {root, file};
}

it("synchronizes only owned versions and leaves third-party lock entries untouched", async () => {
  const {root} = await fixture();
  await expect(syncVersions(root)).rejects.toThrow("synchronize");
  expect(await syncVersions(root, {write: true})).toBe("0.1.2");
  expect(await syncVersions(root)).toBe("0.1.2");
  expect(await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8")).toContain('name = "third-party"\nversion = "0.1.1"');
});

it("rejects stale current install instructions without scanning historical releases", async () => {
  const {root, file} = await fixture();
  await file("docs/release-history.md", "Install dsh-starlite@0.1.0-alpha.0");
  await expect(checkCurrentDocs(root, "0.1.2")).resolves.toBeUndefined();
  await file("packages/dsh-plugin/README.en.md", "Install dsh-starlite@0.1.1");
  await expect(checkCurrentDocs(root, "0.1.2")).rejects.toThrow("stale version");
});

it("classifies prose separately but never skips release inputs, dependencies or code", () => {
  expect(docsOnly(["README.md", "packages/dsh-plugin/README.en.md", "docs/release.md", "CHANGELOG.md"])).toBe(true);
  for (const path of ["release/starlite.rev", "release/default-models.json", "package.json", "pnpm-lock.yaml", ".changeset/change.md", "apps/desktop/src/pet.ts", "tools/release.mjs", ".github/workflows/ci.yml"]) expect(docsOnly(["README.md", path])).toBe(false);
  expect(docsOnly([])).toBe(false);
});

it("promotes only a successful preparation from main whose source matches the manifest", () => {
  const repo = {full_name: "StarCried/starlite-dsh"};
  const run = {repository: repo, head_repository: repo, path: ".github/workflows/release.yml", event: "workflow_dispatch", head_branch: "main", status: "completed", conclusion: "success", head_sha: "a".repeat(40)};
  const manifest = {repository: repo.full_name, sourceRevision: run.head_sha};
  expect(assertPreparedRun(run, manifest)).toBe(run.head_sha);
  for (const altered of [{repository: {full_name: "other/repo"}}, {head_repository: {full_name: "other/repo"}}, {path: ".github/workflows/ci.yml"}, {head_branch: "feature"}, {event: "pull_request"}, {status: "in_progress"}, {conclusion: "failure"}]) expect(() => assertPreparedRun({...run, ...altered}, manifest)).toThrow("successful main preparation");
  expect(() => assertPreparedRun(run, {...manifest, sourceRevision: "b".repeat(40)})).toThrow("source revision");
});

it("rejects an altered reviewed file and a package outside the seven release assets", async () => {
  const {root, file} = await fixture();
  const names = ["dsh-starlite-0.1.2.tgz", "StarLite-for-DSH_0.1.2_x64-setup.exe", "StarLite-for-DSH_0.1.2_x64-portable.zip", "SOURCE_REVISION", "sbom.cdx.json", "THIRD_PARTY_LICENSES.txt", "SHA256SUMS"];
  const revision = "a".repeat(40), files = [];
  for (const name of names) { const bytes = Buffer.from(name === "SOURCE_REVISION" ? revision : name); await file(name, bytes); files.push({file: name, bytes: bytes.length, sha256: digest(bytes)}); }
  const manifest = {schemaVersion: 1, repository: "StarCried/starlite-dsh", sourceRevision: revision, runtimeRevision: "b".repeat(40), version: "0.1.2", tag: "v0.1.2", channel: "latest", files, packages: [{...files[0], name: "dsh-starlite", version: "0.1.2", integrity: integrity(Buffer.from(names[0]))}]};
  await expect(verifyFiles(manifest, root)).resolves.toBe(manifest);
  await expect(verifyFiles({...manifest, packages: [{...manifest.packages[0], file: "../other.tgz"}]}, root)).rejects.toThrow("reviewed release files");
  await writeJson(join(root, "sbom.cdx.json"), {changed: true});
  await expect(verifyFiles(manifest, root)).rejects.toThrow("Release file changed");
});

it("skips identical public archive bytes and rejects conflicting published content", async () => {
  const bytes = Buffer.from("reviewed archive"), pkg = {name: "dsh-starlite", version: "0.1.2", bytes: bytes.length, sha256: digest(bytes), integrity: integrity(bytes)};
  const mock = archive => vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({dist: {tarball: "https://registry.npmjs.org/dsh-starlite/-/dsh-starlite-0.1.2.tgz"}}))).mockResolvedValueOnce(new Response(archive));
  vi.stubGlobal("fetch", mock(bytes));
  await expect(registryPackage(pkg)).resolves.toHaveProperty("dist");
  vi.stubGlobal("fetch", mock("different archive"));
  await expect(registryPackage(pkg)).rejects.toThrow("Published content conflicts");
  expect(compareVersions("0.1.3", "0.1.2")).toBeGreaterThan(0);
  expect(compareVersions("0.1.2", "0.1.2-alpha.9")).toBeGreaterThan(0);
  expect(compareVersions("0.1.2-alpha.10", "0.1.2-alpha.9")).toBeGreaterThan(0);
});
