import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWindowsGuiExecutable, parseCompanionManifest, prepareEmbeddedCompanion } from "../src/bootstrap.js";

const VERSION = "0.1.0-alpha.0";
const EXE = "dsh-inochi2d-pet.exe";
const roots: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function pe(): Buffer {
  const bytes = Buffer.alloc(256), offset = 64;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(offset, 0x3c); bytes.writeUInt32LE(0x00004550, offset);
  bytes.writeUInt16LE(0x8664, offset + 4); bytes.writeUInt16LE(112, offset + 20);
  bytes.writeUInt16LE(0x20b, offset + 24); bytes.writeUInt16LE(2, offset + 24 + 68);
  return bytes;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "starlite-bootstrap-")); roots.push(root);
  const assets = join(root, "assets"), cache = join(root, "cache"); await mkdir(assets);
  const executable = pe(), archive = Buffer.from("generated test VRM, no character artwork");
  const manifest = {
    schemaVersion: 2, version: VERSION, platform: "windows-x64",
    executable: {file: EXE, sha256: sha(executable), bytes: executable.length},
    defaultModel: {title: "微光 v3.0", url: "https://example.test/character.vrm", sha256: sha(archive), bytes: archive.length},
  };
  await Promise.all([
    writeFile(join(assets, EXE), executable), writeFile(join(assets, "LICENSE"), "BSD test notice"),
    writeFile(join(assets, "THIRD_PARTY_LICENSES.txt"), "generated dependency notice"),
    writeFile(join(assets, "manifest.json"), JSON.stringify(manifest)),
  ]);
  const request = vi.fn<typeof fetch>(async () => new Response(archive, {headers: {"Content-Length": String(archive.length)}}));
  return {root, assets, cache, manifest, executable, archive, request,
    options: {assetDirectory: assets, cacheDirectory: cache, expectedVersion: VERSION, fetch: request as typeof fetch}};
}

describe("embedded Windows companion and separate character bootstrap", () => {
  it("prepares the program without requesting character assets while the model is disabled", async () => {
    const f = await fixture();
    const disabled = await prepareEmbeddedCompanion({...f.options,acquireDefaultModel:false});
    expect(disabled.defaultModelReady).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    expect(await readdir(join(disabled.executable, ".."))).not.toContain("default-model.vrm");
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(true);
    expect(f.request).toHaveBeenCalledOnce();
    expect((await prepareEmbeddedCompanion({...f.options,acquireDefaultModel:false})).defaultModelReady).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("atomically stages the program, downloads a hash-pinned VRM and reuses both on restart", async () => {
    const f = await fixture();
    const first = await prepareEmbeddedCompanion(f.options), second = await prepareEmbeddedCompanion(f.options);
    expect(first).toEqual(second); expect(first.defaultModelReady).toBe(true); expect(f.request).toHaveBeenCalledOnce();
    expect(await readFile(first.executable)).toEqual(f.executable);
    const directory = join(first.executable, "..");
    expect((await readdir(directory)).sort()).toEqual([EXE, "LICENSE", "THIRD_PARTY_LICENSES.txt", "default-model.json", "default-model.vrm"].sort());
    const descriptor = JSON.parse(await readFile(join(directory, "default-model.json"), "utf8"));
    expect(descriptor).toEqual({schemaVersion: 2, title: "微光 v3.0", sha256: sha(f.archive), bytes: f.archive.length, file: "default-model.vrm"});
    expect(JSON.stringify(descriptor)).not.toContain("url");
    expect(f.request).toHaveBeenCalledWith(f.manifest.defaultModel.url, expect.objectContaining({method: "GET", redirect: "error", signal: expect.any(AbortSignal)}));
    expect((await readdir(f.cache)).some(name => name.startsWith(".stage-"))).toBe(false);
  });

  it("rejects a corrupt embedded program and a corrupt existing cached program", async () => {
    const f = await fixture();
    await writeFile(join(f.assets, EXE), "corrupt");
    await expect(prepareEmbeddedCompanion(f.options)).rejects.toThrow(/integrity/);
    expect(f.request).not.toHaveBeenCalled();
    await writeFile(join(f.assets, EXE), f.executable);
    const prepared = await prepareEmbeddedCompanion(f.options);
    await writeFile(prepared.executable, "changed cached EXE");
    await expect(prepareEmbeddedCompanion(f.options)).rejects.toThrow(/integrity/);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("retains an explicit descriptor and program on download failure, then retries on restart", async () => {
    const f = await fixture(); f.request.mockRejectedValueOnce(new Error("network detail must not be logged"));
    const failed = await prepareEmbeddedCompanion(f.options);
    expect(failed.defaultModelReady).toBe(false);
    expect(JSON.parse(await readFile(join(failed.executable, "..", "default-model.json"), "utf8"))).toHaveProperty("file", "default-model.vrm");
    expect(await readdir(join(failed.executable, ".."))).not.toContain("default-model.vrm");
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each(["digest", "oversize", "short", "redirect", "length"])("rejects invalid character response: %s", async kind => {
    const f = await fixture();
    let response: Response;
    if (kind === "redirect") response = new Response(null, {status: 302, headers: {Location: "https://other.test/model.zip"}});
    else {
      const body = kind === "oversize" ? Buffer.concat([f.archive, Buffer.from("extra")]) : kind === "short" ? f.archive.subarray(1) : kind === "digest" ? Buffer.alloc(f.archive.length) : f.archive;
      response = new Response(body, {headers: kind === "length" ? {"Content-Length": "1"} : {}});
    }
    f.request.mockResolvedValueOnce(response);
    const prepared = await prepareEmbeddedCompanion(f.options);
    expect(prepared.defaultModelReady).toBe(false);
    expect((await readdir(join(prepared.executable, ".."))).some(name => name === "default-model.vrm" || name.startsWith(".download-"))).toBe(false);
  });

  const releaseUrl = "https://github.com/StarCried/starlite/releases/download/weiguang-v3.0/Weiguang.vrm";
  const assetUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?sig=test-signed-asset";

  async function releaseFixture(url = releaseUrl) {
    const f = await fixture();
    f.manifest.defaultModel.url = url;
    await writeFile(join(f.assets, "manifest.json"), JSON.stringify(f.manifest));
    return f;
  }

  it("follows a canonical GitHub Release to its official asset with one shared timeout and no credentials", async () => {
    const f = await releaseFixture();
    const redirect = new Response("redirect body", {status: 302, headers: {Location: assetUrl}});
    f.request.mockResolvedValueOnce(redirect);
    const prepared = await prepareEmbeddedCompanion(f.options);
    expect(prepared.defaultModelReady).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.map(([url]) => url)).toEqual([releaseUrl, assetUrl]);
    const signal = f.request.mock.calls[0]![1]!.signal;
    for (const [, init] of f.request.mock.calls) {
      expect(init).toEqual({method: "GET", redirect: "manual", credentials: "omit", signal});
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(redirect.body?.locked).toBe(false);
    expect((await redirect.body?.getReader().read())?.done).toBe(true);
    const directory = join(prepared.executable, "..");
    expect(await readFile(join(directory, "default-model.vrm"))).toEqual(f.archive);
    const descriptor = await readFile(join(directory, "default-model.json"), "utf8");
    expect(descriptor).not.toContain("sig=");
    expect(descriptor).not.toContain("url");
    expect((await readdir(directory)).some(name => name.startsWith(".download-"))).toBe(false);
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://release-assets.githubusercontent.com/fixture",
    "https://127.0.0.1/fixture",
    "https://[::1]/fixture",
    "https://user:password@release-assets.githubusercontent.com/fixture",
    "https://release-assets.githubusercontent.com:444/fixture",
    "https://other.test/fixture",
    "https://release-assets.githubusercontent.com.other.test/fixture",
    "https://objects.githubusercontent.com/fixture",
    "https://github.com/StarCried/starlite/releases/download/other/Weiguang.vrm",
    "https://release-assets.githubusercontent.com/fixture#fragment",
  ])("rejects an unapproved GitHub Release redirect: %s", async location => {
    const f = await releaseFixture();
    f.request.mockResolvedValueOnce(new Response(null, {status: 302, headers: {Location: location}}));
    const prepared = await prepareEmbeddedCompanion(f.options);
    expect(prepared.defaultModelReady).toBe(false);
    expect(await readFile(prepared.executable)).toEqual(f.executable);
    expect(f.request).toHaveBeenCalledOnce();
    expect((await readdir(join(prepared.executable, ".."))).some(name => name === "default-model.vrm" || name.startsWith(".download-"))).toBe(false);
  });

  it.each([
    "https://example.test/character.vrm",
    "https://github.com/StarCried/starlite/blob/main/character.vrm",
    "https://github.com/StarCried/starlite/releases/latest/download/character.vrm",
    "https://github.com:444/StarCried/starlite/releases/download/v1/character.vrm",
    `${releaseUrl}?download=1`,
  ])("does not grant redirect permission to a noncanonical source: %s", async source => {
    const f = await releaseFixture(source);
    f.request.mockResolvedValueOnce(new Response(null, {status: 302, headers: {Location: assetUrl}}));
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("bounds GitHub asset hops and rejects redirect loops without leaving partial files", async () => {
    const f = await releaseFixture();
    f.request.mockImplementation(async () => new Response(null, {status: 302, headers: {Location: `${assetUrl}&hop=${f.request.mock.calls.length}`}}));
    const prepared = await prepareEmbeddedCompanion(f.options);
    expect(prepared.defaultModelReady).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(4); // Initial request plus at most three asset hops.
    expect((await readdir(join(prepared.executable, ".."))).some(name => name.startsWith(".download-"))).toBe(false);
    f.request.mockReset().mockResolvedValue(new Response(null, {status: 307, headers: {Location: assetUrl}}));
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("keeps atomic cache and digest validation after an approved GitHub redirect", async () => {
    const f = await releaseFixture(), prepared = await prepareEmbeddedCompanion(f.options);
    const model = join(prepared.executable, "..", "default-model.vrm");
    await writeFile(model, "corrupt ordinary cache");
    f.request.mockResolvedValueOnce(new Response(null, {status: 302, headers: {Location: assetUrl}}));
    f.request.mockResolvedValueOnce(new Response(Buffer.alloc(f.archive.length)));
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(false);
    expect(await readFile(model, "utf8")).toBe("corrupt ordinary cache");
    expect((await readdir(join(model, ".."))).some(name => name.startsWith(".download-"))).toBe(false);
    f.request.mockResolvedValueOnce(new Response(null, {status: 302, headers: {Location: assetUrl}}));
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(true);
    expect(await readFile(model)).toEqual(f.archive);
  });

  it("honors cancellation between GitHub hops before requesting a signed asset", async () => {
    const f = await releaseFixture(), controller = new AbortController();
    f.request.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(null, {status: 302, headers: {Location: assetUrl}});
    });
    await expect(prepareEmbeddedCompanion({...f.options, signal: controller.signal})).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
    const [directory] = await readdir(f.cache);
    expect((await readdir(join(f.cache, directory!))).some(name => name === "default-model.vrm" || name.startsWith(".download-"))).toBe(false);
  });

  it("repairs a corrupt ordinary cache archive only after a replacement passes its pinned digest", async () => {
    const f = await fixture(), prepared = await prepareEmbeddedCompanion(f.options);
    const archive = join(prepared.executable, "..", "default-model.vrm"); await writeFile(archive, "changed archive");
    f.request.mockResolvedValueOnce(new Response("invalid replacement"));
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(false);
    expect(await readFile(archive, "utf8")).toBe("changed archive");
    expect((await prepareEmbeddedCompanion(f.options)).defaultModelReady).toBe(true);
    expect(await readFile(archive)).toEqual(f.archive); expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("preserves complete dependency notices larger than 4 MiB, within the 8 MiB program allowance", async () => {
    const f = await fixture(), notice = Buffer.alloc(4 * 1024 * 1024 + 80_215, 65);
    await writeFile(join(f.assets, "THIRD_PARTY_LICENSES.txt"), notice);
    const prepared = await prepareEmbeddedCompanion(f.options);
    expect((await readFile(join(prepared.executable, "..", "THIRD_PARTY_LICENSES.txt"))).equals(notice)).toBe(true);
    expect(await prepareEmbeddedCompanion(f.options)).toEqual(prepared);
  });

  it("uses a different cache directory when the character changes, even with the same program", async () => {
    const f = await fixture(), first = await prepareEmbeddedCompanion(f.options);
    const secondArchive = Buffer.from("new generated character");
    f.manifest.defaultModel.sha256 = sha(secondArchive); f.manifest.defaultModel.bytes = secondArchive.length;
    await writeFile(join(f.assets, "manifest.json"), JSON.stringify(f.manifest)); f.request.mockResolvedValueOnce(new Response(secondArchive));
    const second = await prepareEmbeddedCompanion(f.options);
    expect(second.executable).not.toBe(first.executable); expect(second.defaultModelReady).toBe(true);
  });

  it("cancels startup without leaving a partial archive", async () => {
    const f = await fixture(), controller = new AbortController();
    f.request.mockImplementationOnce(async () => {controller.abort(); throw new DOMException("aborted", "AbortError");});
    await expect(prepareEmbeddedCompanion({...f.options, signal: controller.signal})).rejects.toThrow();
    const directories = await readdir(f.cache);
    expect(directories.some(name => name.startsWith(".stage-"))).toBe(false);
    expect((await readdir(join(f.cache, directories[0]!))).some(name => name.startsWith(".download-"))).toBe(false);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(prepareEmbeddedCompanion({...f.options, signal: alreadyAborted.signal})).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("does not follow cache-directory junctions", async () => {
    const f = await fixture(), target = join(f.root, "target"); await mkdir(target);
    await symlink(target, f.cache, "junction");
    await expect(prepareEmbeddedCompanion(f.options)).rejects.toThrow(/unsafe/); expect(f.request).not.toHaveBeenCalled();
  });

  it("validates PE architecture and GUI subsystem before executing anything", () => {
    expect(() => assertWindowsGuiExecutable(pe())).not.toThrow();
    const console = pe(); console.writeUInt16LE(3, 64 + 24 + 68);
    const x86 = pe(); x86.writeUInt16LE(0x14c, 64 + 4);
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(80), console, x86]) expect(() => assertWindowsGuiExecutable(invalid)).toThrow();
  });

  it("rejects malformed manifests, path fields, versions and unapproved local HTTP", async () => {
    const f = await fixture(), parse = (value: unknown) => parseCompanionManifest(Buffer.from(JSON.stringify(value)), VERSION);
    expect(() => parse(f.manifest)).not.toThrow();
    const local = {...f.manifest, defaultModel: {...f.manifest.defaultModel, url: "http://127.0.0.1:1234/character.vrm", localTest: true}};
    expect(() => parse(local)).not.toThrow();
    for (const changed of [
      {...f.manifest, version: "0.0.0"}, {...f.manifest, platform: "windows-arm64"},
      {...f.manifest, executable: {...f.manifest.executable, file: "../dsh-inochi2d-pet.exe"}},
      {...f.manifest, executable: {...f.manifest.executable, bytes: 65 * 1024 * 1024}},
      {...f.manifest, executable: {...f.manifest.executable, sha256: "a".repeat(63)}},
      ...["http://127.0.0.1/file", "http://localhost/file", "http://192.168.1.1/file", "file:///tmp/a", "https://user:password@example.test/file", "https://example.test/file#fragment"].map(url => ({...f.manifest, defaultModel: {...f.manifest.defaultModel, url}})),
      {...local, defaultModel: {...local.defaultModel, url: "http://localhost:1234/file"}},
      {...local, defaultModel: {...local.defaultModel, url: "http://127.1:1234/file"}},
      {...local, defaultModel: {...local.defaultModel, url: "http://2130706433:1234/file"}},
      {...f.manifest, registry: "unused-stale-path"},
    ]) expect(() => parse(changed)).toThrow();
  });
});
