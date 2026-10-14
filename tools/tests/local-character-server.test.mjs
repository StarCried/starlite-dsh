import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { serveLocalCharacter } from "../local-character-server.mjs";
import { sha256 } from "../plugin-desktop-assets.mjs";

const temporary = [], servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
  for (const path of temporary.splice(0)) {
    const base = await realpath(tmpdir());
    if (dirname(path) !== base || !path.startsWith(join(base, "starlite-character-server-"))) throw Error("unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "starlite-character-server-")); temporary.push(root);
  const modelPath = join(root, "synthetic.vrm"), descriptorPath = join(root, "descriptor.json");
  await writeFile(modelPath, "artwork-free fixture, native importer validates VRM contents");
  return { modelPath, descriptorPath };
}

it("serves an immutable bounded file only on loopback and writes a pinned local-test descriptor", async () => {
  const options = await fixture(), { server, descriptor } = await serveLocalCharacter(options); servers.push(server);
  expect(server.address().address).toBe("127.0.0.1");
  expect(JSON.parse(await readFile(options.descriptorPath, "utf8"))).toEqual(descriptor);
  expect(descriptor.localTest).toBe(true); expect(descriptor.url).toMatch(/\.vrm$/u);
  await writeFile(options.modelPath, "replaced after immutable startup snapshot");
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
  await expect(serveLocalCharacter({ ...options, modelPath: join(dirname(options.modelPath), "retired.zip") })).rejects.toThrow(/\.vrm/);
  await writeFile(options.descriptorPath, "existing");
  await expect(serveLocalCharacter(options)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(options.descriptorPath, "utf8")).toBe("existing");
});

it("starts through the documented two-argument CLI and keeps serving the VRM", async () => {
  const options = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../local-character-server.mjs", import.meta.url)), options.modelPath, options.descriptorPath], {stdio:["ignore","pipe","pipe"],windowsHide:true});
  const exited = once(child, "exit");
  try {
    await new Promise((accept, reject) => {
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; if (output.includes("source ready")) accept(); });
      child.once("error", reject);
      child.once("exit", code => reject(Error("model source exited before ready: " + code)));
    });
    const descriptor = JSON.parse(await readFile(options.descriptorPath, "utf8"));
    const response = await fetch(descriptor.url);
    expect(response.status).toBe(200);
    expect(sha256(Buffer.from(await response.arrayBuffer()))).toBe(descriptor.sha256);
  } finally { child.kill(); await exited; }
});
