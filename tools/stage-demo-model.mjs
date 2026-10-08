import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validDemoMappings } from "./release-mappings.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "assets/microlight");
const destination = resolve(root, "apps/desktop/src-tauri/resources/microlight");
const files = ["model.inp", "defaults.json", "ASSET_LICENSE.md"];

for (const name of files) {
  const path = resolve(source, name);
  if (!(await stat(path).catch(() => undefined))?.isFile()) {
    throw new Error(`approved demo-model release input is missing: ${path}`);
  }
}
const defaults = JSON.parse(await readFile(resolve(source, "defaults.json"), "utf8"));
if (!validDemoMappings(defaults.mappings)) {
  throw new Error("demo defaults must name Idle and explicitly map or disable every optional state");
}
const license = await readFile(resolve(source, "ASSET_LICENSE.md"), "utf8");
if (!/SPDX-License-Identifier:/u.test(license) || !/redistribut|再分发/iu.test(license)) {
  throw new Error("demo-model authorization is not explicit enough for redistribution");
}

await mkdir(destination, { recursive: true });
await Promise.all(files.map((name) => copyFile(resolve(source, name), resolve(destination, name))));
console.log(`Staged the approved MicroLight release model in ${destination}`);
