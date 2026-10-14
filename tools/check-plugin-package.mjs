import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopExecutable, assertDesktopManifest, DESKTOP_ASSET_DIRECTORY, DESKTOP_ASSET_FILES, ordinaryBuildFile } from "./plugin-desktop-assets.mjs";

/** Validate the delivered archive, not only the assets staged for the next pack. */
export async function checkPluginPackage(root, { allowLocalTest = true } = {}) {
  const packageJson = JSON.parse(await readFile(resolve(root, "packages/dsh-plugin/package.json"), "utf8"));
  const archive = resolve(root, `packages/dsh-plugin/.pack/dsh-starlite-${packageJson.version}.tgz`);
  const info = await stat(archive).catch(() => undefined);
  if (!info?.isFile() || info.size === 0 || info.size > 16 * 1024 * 1024) {
    throw new Error("packed DSH bundle is missing, empty, or unexpectedly large");
  }
  const entries = execFileSync("tar", ["-tzf", archive], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }).trim().split(/\r?\n/u).sort();
  const expected = [
    "package/LICENSE", "package/README.md", "package/cordis.patch.yml",
    "package/dist/client.js", "package/dist/index.js", "package/dist/index.js.map", "package/package.json",
    ...DESKTOP_ASSET_FILES.map(name => `package/assets/windows-x64/${name}`),
  ].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`unexpected npm tarball contents:\n${entries.join("\n")}`);
  }
  const extract = (name, maxBuffer) => execFileSync("tar", ["-xOzf", archive, name], { cwd: root, maxBuffer, windowsHide: true });
  const manifest = assertDesktopManifest(JSON.parse(extract("package/assets/windows-x64/manifest.json", 16 * 1024).toString("utf8")), { expectedVersion: packageJson.version, allowLocalTest });
  assertDesktopExecutable(extract("package/assets/windows-x64/dsh-inochi2d-pet.exe", 64 * 1024 * 1024), manifest.executable);
  for (const name of DESKTOP_ASSET_FILES) {
    const maximum = name === "manifest.json" ? 16 * 1024 : name.endsWith(".exe") ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
    const packed = extract(`package/assets/windows-x64/${name}`, maximum);
    const staged = await ordinaryBuildFile(root, `${DESKTOP_ASSET_DIRECTORY}/${name}`, maximum);
    if (!packed.equals(staged)) throw Error(`packed desktop asset differs from staging: ${name}`);
  }
  return { archive, fileCount: entries.length, bytes: info.size, localTest: manifest.defaultModel.localTest === true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkPluginPackage(resolve(fileURLToPath(new URL("..", import.meta.url))));
  console.log(`Verified ${result.archive}: ${result.fileCount} allow-listed files, ${result.bytes} bytes; Windows GUI executable and ${result.localTest ? "LOCAL TEST ONLY" : "HTTPS"} character reference.`);
}
