import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(resolve(root, "packages/dsh-plugin/package.json"), "utf8"),
);
const archive = resolve(
  root,
  `packages/dsh-plugin/.pack/dsh-inochi2d-pet-${packageJson.version}.tgz`,
);
const info = await stat(archive).catch(() => undefined);
if (!info?.isFile() || info.size === 0 || info.size > 512 * 1024) {
  throw new Error("packed DSH bundle is missing, empty, or unexpectedly large");
}
const entries = execFileSync("tar", ["-tzf", archive], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).trim().split(/\r?\n/u).sort();
const expected = [
  "package/LICENSE",
  "package/README.md",
  "package/cordis.patch.yml",
  "package/dist/client.js",
  "package/dist/index.js",
  "package/dist/index.js.map",
  "package/package.json",
].sort();
if (JSON.stringify(entries) !== JSON.stringify(expected)) {
  throw new Error(`unexpected npm tarball contents:\n${entries.join("\n")}`);
}
console.log(`Verified ${archive}: ${entries.length} allow-listed files, ${info.size} bytes.`);
