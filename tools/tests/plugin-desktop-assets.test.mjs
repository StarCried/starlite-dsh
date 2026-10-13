import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertDesktopExecutable, assertDesktopManifest, assertStarterCharacter, sha256 } from "../plugin-desktop-assets.mjs";
import { stagePluginDesktop } from "../stage-plugin-desktop.mjs";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "starlite-plugin-assets-"))) throw Error("unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
});
function executable() {
  const bytes = Buffer.alloc(256), pe = 64;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(112, pe + 20);
  bytes.writeUInt16LE(0x20b, pe + 24); bytes.writeUInt16LE(2, pe + 24 + 68);
  return bytes;
}
const starter = { title: "Generated fixture", url: "https://example.com/character.zip", sha256: "a".repeat(64), bytes: 12, modelSha256: "b".repeat(64) };
const version = "0.1.0-alpha.0";
async function file(root, path, bytes) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "starlite-plugin-assets-")); temporary.push(root);
  await file(root, "packages/dsh-plugin/package.json", JSON.stringify({ version }));
  await file(root, "apps/desktop/src-tauri/tauri.conf.json", JSON.stringify({ productName: "StarLite for DSH", version }));
  await file(root, "apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe", executable());
  await file(root, "LICENSE", "generated notice"); await file(root, "release-output/THIRD_PARTY_LICENSES.txt", "generated dependencies");
  await file(root, "release-output/character.json", JSON.stringify(starter));
  return root;
}

it("stages only four program files, binds version and hash, and leaves character artwork external", async () => {
  const root = await fixture();
  await file(root, "release-output/private.vrm", "generated excluded fixture");
  const manifest = await stagePluginDesktop(root, join(root, "release-output/character.json"));
  expect(manifest.executable).toEqual({ file: "dsh-inochi2d-pet.exe", bytes: 256, sha256: sha256(executable()) });
  expect(manifest.starterCharacter).toEqual(starter);
  expect(await readFile(join(root, "packages/dsh-plugin/assets/windows-x64/dsh-inochi2d-pet.exe"))).toEqual(executable());
  expect(assertDesktopManifest(manifest, { expectedVersion: version })).toBe(manifest);
  expect(() => assertDesktopManifest(manifest, { expectedVersion: "0.2.0" })).toThrow(/version/);
  await stagePluginDesktop(root, join(root, "release-output/character.json"));
});

it("rejects corrupt or console executables and mismatched hashes", () => {
  const expected = { bytes: 256, sha256: sha256(executable()) };
  assertDesktopExecutable(executable(), expected);
  const consoleExe = executable(); consoleExe.writeUInt16LE(3, 64 + 24 + 68);
  expect(() => assertDesktopExecutable(consoleExe, { bytes: 256, sha256: sha256(consoleExe) })).toThrow(/GUI/);
  expect(() => assertDesktopExecutable(executable(), { ...expected, bytes: 257 })).toThrow(/mismatch/);
  expect(() => assertDesktopExecutable(executable(), { ...expected, sha256: "c".repeat(64) })).toThrow(/mismatch/);
});

it("allows explicitly local test sources only during local acceptance", () => {
  const local = { ...starter, url: "http://127.0.0.1:44123/character.zip", localTest: true };
  expect(assertStarterCharacter(local)).toBe(local);
  expect(() => assertStarterCharacter(local, { allowLocalTest: false })).toThrow(/publicly released/);
  for (const value of [
    { ...local, url: "http://localhost:44123/character.zip" },
    { ...local, url: "http://192.168.1.2:44123/character.zip" },
    { ...starter, url: "http://example.com/a.zip" },
    { ...starter, url: "https://user:password@example.com/a.zip" },
    { ...starter, url: "https://example.com/a.zip?token=secret" },
    { ...starter, bytes: 64 * 1024 * 1024 + 1 },
    { ...starter, bytes: 1.1 },
    { ...starter, modelSha256: "bad" },
    { ...starter, localTest: false },
    { ...starter, extraFile: "private.blend" },
  ]) expect(() => assertStarterCharacter(value)).toThrow();
});

it("rejects redirected build inputs and unexpected staged assets", async () => {
  const root = await fixture(), external = await fixture();
  await rm(join(root, "release-output"), { recursive: true });
  await symlink(join(external, "release-output"), join(root, "release-output"), "junction");
  await expect(stagePluginDesktop(root, join(root, "release-output/character.json"))).rejects.toThrow(/unsafe/);
  await rm(join(root, "release-output"), { recursive: true });
  await file(root, "release-output/THIRD_PARTY_LICENSES.txt", "notice");
  await file(root, "release-output/character.json", JSON.stringify(starter));
  await file(root, "packages/dsh-plugin/assets/windows-x64/private.vrm", "generated excluded fixture");
  await expect(stagePluginDesktop(root, join(root, "release-output/character.json"))).rejects.toThrow(/unexpected.*private.vrm/);
});
