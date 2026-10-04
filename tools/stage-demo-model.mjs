import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
if (!validMappings(defaults.mappings)) {
  throw new Error("demo defaults must name Idle and explicitly map or disable every optional state");
}
const license = await readFile(resolve(source, "ASSET_LICENSE.md"), "utf8");
if (!/SPDX-License-Identifier:/u.test(license) || !/redistribut|再分发/iu.test(license)) {
  throw new Error("demo-model authorization is not explicit enough for redistribution");
}

await mkdir(destination, { recursive: true });
await Promise.all(files.map((name) => copyFile(resolve(source, name), resolve(destination, name))));
console.log(`Staged the approved MicroLight release model in ${destination}`);

function validMappings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const optional = ["working", "completed", "error", "blocked", "approval"];
  return typeof value.idle === "string"
    && value.idle.length > 0
    && optional.every((key) => typeof value[key] === "string" || value[key] === null)
    && (typeof value.click === "string" || value.click === null || validPool(value.click))
    && (value.ambient === undefined || validPool(value.ambient));
}

function validPool(pool) {
  return Array.isArray(pool) && pool.length <= 20 && new Set(pool).size === pool.length && pool.every(name => typeof name === "string" && name.length > 0);
}
