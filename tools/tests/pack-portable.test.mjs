import { crc32, inflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertPortableExecutable, packPortable } from "../pack-portable.mjs";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    const base = await realpath(tmpdir());
    if (dirname(path) !== base || !path.startsWith(join(base, "starlite-portable-"))) throw Error("unsafe temporary directory");
    await rm(path, {recursive: true, force: true});
  }
});
const binary = "apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe";
function executable(subsystem = 2) {
  const bytes = Buffer.alloc(256), pe = 64;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(112, pe + 20);
  bytes.writeUInt16LE(0x20b, pe + 24); bytes.writeUInt16LE(subsystem, pe + 24 + 68);
  return bytes;
}
async function file(root, path, bytes) {
  await mkdir(dirname(join(root, path)), {recursive: true});
  await writeFile(join(root, path), bytes);
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "starlite-portable-")); temporary.push(root);
  await file(root, "package.json", JSON.stringify({version: "0.1.0-alpha.0"}));
  await file(root, "apps/desktop/src-tauri/tauri.conf.json", JSON.stringify({productName: "StarLite for DSH", version: "0.1.0-alpha.0"}));
  await file(root, binary, executable());
  await file(root, "LICENSE", "generated license fixture");
  await file(root, "release-output/THIRD_PARTY_LICENSES.txt", "generated dependency notice fixture");
  return root;
}

it("packages exactly four flat files and preserves executable bytes without collecting private assets", async () => {
  const root = await fixture();
  await file(root, "apps/desktop/src-tauri/target/release/forbidden.vrm", "artwork-free excluded fixture");
  await file(root, "release-output/private.blend", "artwork-free excluded fixture");
  const path = await packPortable(root), archive = await readFile(path);
  expect(path).toBe(join(root, "release-output/StarLite-for-DSH_0.1.0-alpha.0_x64-portable.zip"));
  const entries = readArchive(archive);
  expect([...entries.keys()]).toEqual(["dsh-inochi2d-pet.exe", "LICENSE", "THIRD_PARTY_LICENSES.txt", "README.txt"]);
  expect(entries.get("dsh-inochi2d-pet.exe")).toEqual(executable());
  const instructions = entries.get("README.txt").toString();
  expect(instructions).toContain("export DSH_INOCHI2D_PET_EXE='D:\\Apps\\StarLite\\dsh-inochi2d-pet.exe'");
  expect(instructions).toContain("$env:DSH_INOCHI2D_PET_EXE='D:\\Apps\\StarLite\\dsh-inochi2d-pet.exe'");
  expect(instructions).toContain("单个 VRM");
  expect(instructions).not.toContain("微光 ZIP");
  expect(instructions).toContain("WebView2"); expect(instructions).toContain("AppData");
  await expect(packPortable(root)).rejects.toMatchObject({code: "EEXIST"});
  expect(await readFile(path)).toEqual(archive);
});

it("rejects console, non-x64, truncated and invalid executable headers", () => {
  expect(() => assertPortableExecutable(executable(3))).toThrow(/GUI subsystem/);
  const x86 = executable(); x86.writeUInt16LE(0x14c, 68);
  const badOffset = executable(); badOffset.writeUInt32LE(0xfffffff0, 0x3c);
  const truncatedOptionalHeader = executable(); truncatedOptionalHeader.writeUInt16LE(0xffff, 84);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(256), executable().subarray(0, 150), x86, badOffset, truncatedOptionalHeader]) {
    expect(() => assertPortableExecutable(bytes)).toThrow(/PE/);
  }
});

it("rejects missing or empty notices, directories and mismatched or unsafe package identity", async () => {
  const root = await fixture();
  await writeFile(join(root, "LICENSE"), "");
  await expect(packPortable(root)).rejects.toThrow(/invalid size.*LICENSE/);
  await writeFile(join(root, "LICENSE"), "license");
  await rm(join(root, "release-output/THIRD_PARTY_LICENSES.txt"));
  await mkdir(join(root, "release-output/THIRD_PARTY_LICENSES.txt"));
  await expect(packPortable(root)).rejects.toThrow(/missing or unsafe/);
  for (const config of [
    {productName: "Other", version: "0.1.0-alpha.0"},
    {productName: "StarLite for DSH", version: "0.2.0"},
    {productName: "StarLite for DSH", version: "../../outside"},
  ]) {
    await writeFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify(config));
    await expect(packPortable(root)).rejects.toThrow(/identity and version/);
  }
});

it("rejects redirected input directories instead of following them outside the package root", async () => {
  const root = await fixture(), external = await fixture();
  await rm(join(root, "release-output"), {recursive: true});
  await symlink(join(external, "release-output"), join(root, "release-output"), "junction");
  await expect(packPortable(root)).rejects.toThrow(/missing or unsafe/);
});

// Read the central directory independently and check local data, CRC and offsets.
function readArchive(bytes) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50); expect(bytes.readUInt16LE(end + 20)).toBe(0);
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  expect(offset + bytes.readUInt32LE(end + 12)).toBe(end);
  const entries = new Map(); let cursor = offset;
  for (let index = 0; index < count; ++index) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(cursor + 8)).toBe(0x800); expect(bytes.readUInt16LE(cursor + 10)).toBe(8);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(cursor + 42);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const inflated = inflateRawSync(bytes.subarray(data, data + bytes.readUInt32LE(cursor + 20)));
    expect(inflated.length).toBe(bytes.readUInt32LE(cursor + 24));
    expect(crc32(inflated)).toBe(bytes.readUInt32LE(cursor + 16));
    expect(bytes.subarray(local + 30, local + 30 + nameLength).toString()).toBe(name);
    entries.set(name, inflated); cursor += 46 + nameLength + extra + comment;
  }
  expect(cursor).toBe(end);
  return entries;
}
