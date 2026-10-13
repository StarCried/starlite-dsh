import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { get } from "node:http";
import { serveLocalCharacter } from "../local-character-server.mjs";
import { sha256 } from "../plugin-desktop-assets.mjs";

const temporary = [], servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
  for (const path of temporary.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.startsWith(resolve(tmpdir(), "starlite-character-server-"))) throw Error("unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "starlite-character-server-")); temporary.push(root);
  const archivePath = join(root, "synthetic.zip"), descriptorPath = join(root, "descriptor.json");
  await writeFile(archivePath, "artwork-free fixture, native importer validates real ZIP contents");
  return { archivePath, descriptorPath, modelSha256: "a".repeat(64) };
}

it("serves an immutable bounded file only on loopback and writes a pinned local-test descriptor", async () => {
  const options = await fixture(), { server, descriptor } = await serveLocalCharacter(options); servers.push(server);
  expect(server.address().address).toBe("127.0.0.1");
  expect(JSON.parse(await readFile(options.descriptorPath, "utf8"))).toEqual(descriptor);
  expect(descriptor.localTest).toBe(true); expect(descriptor.modelSha256).toBe(options.modelSha256);
  await writeFile(options.archivePath, "replaced after immutable startup snapshot");
  const response = await fetch(descriptor.url), bytes = Buffer.from(await response.arrayBuffer());
  expect(response.status).toBe(200); expect(sha256(bytes)).toBe(descriptor.sha256); expect(bytes.length).toBe(descriptor.bytes);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  const head = await fetch(descriptor.url, { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
  for (const [url, init] of [
    [new URL("/", descriptor.url), {}],
    [descriptor.url, { method: "POST" }],
    [descriptor.url, { headers: { Origin: "https://attacker.example" } }],
  ]) expect((await fetch(url, init)).status).toBe(404);
  expect(await new Promise((accept, reject) => get(descriptor.url, { headers: { Host: "attacker.example" } }, response => { response.resume(); accept(response.statusCode); }).on("error", reject))).toBe(404);
});

it("refuses invalid input and never overwrites an existing descriptor", async () => {
  const options = await fixture();
  await expect(serveLocalCharacter({ ...options, modelSha256: "bad" })).rejects.toThrow(/SHA-256/);
  await writeFile(options.descriptorPath, "existing");
  await expect(serveLocalCharacter(options)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(options.descriptorPath, "utf8")).toBe("existing");
});
