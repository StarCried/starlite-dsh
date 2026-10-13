import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopExecutable, assertDesktopManifest, DESKTOP_ASSET_FILES } from "./plugin-desktop-assets.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(resolve(root, "packages/dsh-plugin/package.json"), "utf8"),
);
const archive = resolve(
  root,
  `packages/dsh-plugin/.pack/dsh-starlite-${packageJson.version}.tgz`,
);
const info = await stat(archive).catch(() => undefined);
if (!info?.isFile() || info.size === 0 || info.size > 16 * 1024 * 1024) {
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
  ...DESKTOP_ASSET_FILES.map(name => `package/assets/windows-x64/${name}`),
].sort();
if (JSON.stringify(entries) !== JSON.stringify(expected)) {
  throw new Error(`unexpected npm tarball contents:\n${entries.join("\n")}`);
}
const manifest = assertDesktopManifest(JSON.parse(extract("package/assets/windows-x64/manifest.json", 16 * 1024).toString("utf8")), { expectedVersion: packageJson.version });
assertDesktopExecutable(extract("package/assets/windows-x64/dsh-inochi2d-pet.exe", 64 * 1024 * 1024), manifest.executable);
for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
  if (extract(`package/assets/windows-x64/${name}`, 8 * 1024 * 1024).length === 0) throw Error(`missing embedded notice: ${name}`);
}
console.log(`Verified ${archive}: ${entries.length} allow-listed files, ${info.size} bytes; Windows GUI executable and ${manifest.defaultModel.localTest ? "LOCAL TEST ONLY" : "HTTPS"} character reference.`);

function extract(name, maxBuffer) {
  return execFileSync("tar", ["-xOzf", archive, name], { cwd: root, maxBuffer, windowsHide: true });
}
