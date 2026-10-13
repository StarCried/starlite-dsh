import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortableExecutable } from "./pack-portable.mjs";
import { assertDesktopManifest, assertStarterCharacter, DESKTOP_ASSET_DIRECTORY, DESKTOP_ASSET_FILES, ordinaryBuildFile, sha256 } from "./plugin-desktop-assets.mjs";

/** Explicitly stage a built program and a separately delivered character reference. */
export async function stagePluginDesktop(rootDirectory, descriptorPath) {
  const root = await realpath(rootDirectory);
  const descriptorInfo = await lstat(descriptorPath).catch(() => undefined);
  if (!descriptorInfo?.isFile() || descriptorInfo.isSymbolicLink() || descriptorInfo.size < 1 || descriptorInfo.size > 16 * 1024) {
    throw Error("pass a bounded, ordinary starter character descriptor JSON file");
  }
  const starterCharacter = assertStarterCharacter(JSON.parse(await readFile(descriptorPath, "utf8")));
  const packageJson = JSON.parse(await ordinaryBuildFile(root, "packages/dsh-plugin/package.json"));
  const config = JSON.parse(await ordinaryBuildFile(root, "apps/desktop/src-tauri/tauri.conf.json"));
  if (config.version !== packageJson.version || config.productName !== "StarLite for DSH") throw Error("desktop and plugin versions must match");
  const executable = await ordinaryBuildFile(root, "apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe");
  assertPortableExecutable(executable);
  const manifest = assertDesktopManifest({
    schemaVersion: 1, version: packageJson.version, platform: "windows-x64",
    executable: { file: "dsh-inochi2d-pet.exe", sha256: sha256(executable), bytes: executable.length }, starterCharacter,
  });
  const entries = [
    ["dsh-inochi2d-pet.exe", executable],
    ["LICENSE", await ordinaryBuildFile(root, "LICENSE", 1024 * 1024)],
    ["THIRD_PARTY_LICENSES.txt", await ordinaryBuildFile(root, "release-output/THIRD_PARTY_LICENSES.txt", 8 * 1024 * 1024)],
    ["manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ];
  let directory = root;
  for (const segment of DESKTOP_ASSET_DIRECTORY.split("/")) {
    directory = join(directory, segment);
    await mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("desktop staging directory is unsafe");
  }
  for (const name of await readdir(directory)) {
    const info = await lstat(join(directory, name));
    if (!DESKTOP_ASSET_FILES.includes(name) || !info.isFile() || info.isSymbolicLink()) throw Error(`unexpected desktop staging file: ${name}`);
  }
  // The manifest is written last. A cancelled build cannot pass the package hash gate.
  for (const [name, bytes] of entries) {
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, join(directory, name));
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2).filter(argument => argument !== "--");
  if (arguments_.length !== 1) throw Error("usage: pnpm stage:plugin -- /absolute/path/starter-character.json");
  const manifest = await stagePluginDesktop(resolve(dirname(fileURLToPath(import.meta.url)), ".."), resolve(arguments_[0]));
  console.log(`Staged Windows desktop ${manifest.version}; ${manifest.starterCharacter.localTest ? "LOCAL TEST ONLY" : "HTTPS character reference"}; no model files included.`);
}
