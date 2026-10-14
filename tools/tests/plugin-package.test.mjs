import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkPluginPackage } from "../check-plugin-package.mjs";
import { DESKTOP_ASSET_FILES, sha256 } from "../plugin-desktop-assets.mjs";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "starlite-package-"))) throw Error("unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
});
const version = "0.1.0-alpha.0";
const model = { title: "Generated fixture", url: "https://example.com/fixture.vrm", sha256: "a".repeat(64), bytes: 12 };
const json = value => Buffer.from(`${JSON.stringify(value)}\n`);
function executable() {
  const bytes = Buffer.alloc(256), pe = 64;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(112, pe + 20);
  bytes.writeUInt16LE(0x20b, pe + 24); bytes.writeUInt16LE(2, pe + 24 + 68);
  return bytes;
}
async function file(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}
async function fixture(defaultModel = model) {
  const root = await mkdtemp(join(tmpdir(), "starlite-package-")); temporary.push(root);
  const exe = executable();
  const manifest = { schemaVersion: 2, version, platform: "windows-x64", executable: { file: "dsh-inochi2d-pet.exe", bytes: exe.length, sha256: sha256(exe) }, defaultModel };
  const assets = { "dsh-inochi2d-pet.exe": exe, "manifest.json": json(manifest), "LICENSE": Buffer.from("Generated program notice"), "THIRD_PARTY_LICENSES.txt": Buffer.from("Generated dependency notice") };
  await file(root, "packages/dsh-plugin/package.json", json({ version }));
  for (const name of DESKTOP_ASSET_FILES) await file(root, `packages/dsh-plugin/assets/windows-x64/${name}`, assets[name]);
  async function pack(changes = {}) {
    const files = {
      "LICENSE": Buffer.from("Generated bundle notice"), "README.md": Buffer.from("Generated instructions"),
      "cordis.patch.yml": Buffer.from("[]"), "dist/client.js": Buffer.from("generated client"),
      "dist/index.js": Buffer.from("generated host"), "dist/index.js.map": Buffer.from("{}"), "package.json": json({ name: "dsh-starlite", version }),
      ...Object.fromEntries(DESKTOP_ASSET_FILES.map(name => [`assets/windows-x64/${name}`, changes[name] ?? assets[name]])),
    };
    const source = join(root, "archive-source");
    for (const [name, bytes] of Object.entries(files)) await file(source, `package/${name}`, bytes);
    const archive = join(root, `packages/dsh-plugin/.pack/dsh-starlite-${version}.tgz`);
    await mkdir(dirname(archive), { recursive: true });
    execFileSync("tar", ["-czf", relative(source, archive).split(sep).join("/"), ...Object.keys(files).map(name => `package/${name}`)], { cwd: source, windowsHide: true });
  }
  await pack();
  return { root, assets, manifest, pack };
}

it("accepts a public archive whose four desktop assets exactly match staging", async () => {
  const { root } = await fixture();
  expect(await checkPluginPackage(root, { allowLocalTest: false })).toMatchObject({ fileCount: 11, localTest: false });
});

it("rejects an old local-only archive even after staging a public model source", async () => {
  const { root, manifest, pack } = await fixture();
  const local = { ...manifest, defaultModel: { ...model, url: "http://127.0.0.1:44123/fixture.vrm", localTest: true } };
  await pack({ "manifest.json": json(local) });
  await expect(checkPluginPackage(root, { allowLocalTest: false })).rejects.toThrow(/local-test character source cannot be publicly released/);
});

it.each(DESKTOP_ASSET_FILES)("rejects a valid but stale packed %s", async name => {
  const { root, assets, manifest, pack } = await fixture();
  let changes = { [name]: Buffer.from("A different generated notice") };
  if (name === "manifest.json") changes = { [name]: json({ ...manifest, defaultModel: { ...model, title: "New fixture title" } }) };
  if (name.endsWith(".exe")) {
    const exe = Buffer.from(assets[name]); exe[exe.length - 1] = 1;
    changes = { [name]: exe, "manifest.json": json({ ...manifest, executable: { ...manifest.executable, sha256: sha256(exe) } }) };
  }
  await pack(changes);
  await expect(checkPluginPackage(root, { allowLocalTest: false })).rejects.toThrow(`packed desktop asset differs from staging: ${name}`);
});

it("allows matching local assets only in the explicit local validation mode", async () => {
  const { root } = await fixture({ ...model, url: "http://127.0.0.1:44123/fixture.vrm", localTest: true });
  expect(await checkPluginPackage(root, { allowLocalTest: true })).toMatchObject({ fileCount: 11, localTest: true });
  await expect(checkPluginPackage(root, { allowLocalTest: false })).rejects.toThrow(/publicly released/);
});
