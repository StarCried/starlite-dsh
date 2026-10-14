import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProgramAssets } from "./release-assets.mjs";
import { checkReleaseInstaller } from "./release-installer.mjs";
import { checkPluginPackage } from "./check-plugin-package.mjs";
import { assertDesktopExecutable, assertDesktopManifest, ordinaryBuildFile } from "./plugin-desktop-assets.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const arguments_ = process.argv.slice(2).filter(argument => argument !== "--");
if (arguments_.some(argument => argument !== "--local-test") || arguments_.length > 1) throw Error("usage: pnpm check:release [-- --local-test]");
const localTest = arguments_.includes("--local-test");
import { RUNTIMES, assertRuntime, assertRuntimeLayout } from "./model-runtime.mjs";
const versionFiles = [
  ["workspace", "package.json", "version"],
  ["desktop", "apps/desktop/package.json", "version"],
  ["protocol", "packages/protocol/package.json", "version"],
  ["npm bundle", "packages/dsh-plugin/package.json", "version"],
  ["Tauri", "apps/desktop/src-tauri/tauri.conf.json", "version"],
];
const versions = [];

for (const [label, relativePath, key] of versionFiles) {
  const json = await jsonFile(relativePath);
  const value = json?.[key];
  if (typeof value !== "string") failures.push(`${label} version is missing`);
  else versions.push([label, value]);
}
const cargo = await textFile("apps/desktop/src-tauri/Cargo.toml");
const cargoVersion = cargo?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
if (cargoVersion) versions.push(["Cargo", cargoVersion]);
else failures.push("Cargo version is missing");
const uniqueVersions = new Set(versions.map(([, version]) => version));
if (uniqueVersions.size !== 1) {
  failures.push(`release versions differ: ${versions.map(([name, value]) => `${name}=${value}`).join(", ")}`);
}

const pin = (await textFile("release/starlite.rev"))?.trim();
if (!pin || !/^[0-9a-f]{40}$/u.test(pin)) {
  failures.push("release/starlite.rev must contain one public 40-character Git revision");
}

try { await assertRuntimeLayout(resolve(root, "apps/desktop/public/runtime")); } catch (error) { failures.push(String(error)); }
for (const name of RUNTIMES) {
  try { await assertRuntime(name, resolve(root, "apps/desktop/public/runtime", name)); } catch (error) { failures.push(String(error)); }
  const metadata = await jsonFile(`apps/desktop/public/runtime/${name}/runtime-provenance.json`);
  if (!metadata || metadata.dirty !== false || metadata.revision !== pin) failures.push(`${name} must match the clean runtime pin`);
  if (typeof metadata?.repository !== "string" || !/github\.com[/:]StarCried\/starlite(?:\.git)?$/iu.test(metadata.repository)) failures.push(`${name} provenance does not name the public StarCried/starlite repository`);
}

failures.push(...await checkProgramAssets(root));

const version = versions[0]?.[1] ?? "unknown";
await requiredFile(`packages/dsh-plugin/.pack/dsh-starlite-${version}.tgz`, 1);
try {
  const manifest = assertDesktopManifest(JSON.parse(await ordinaryBuildFile(root, "packages/dsh-plugin/assets/windows-x64/manifest.json", 16 * 1024)), { expectedVersion: version, allowLocalTest: localTest });
  const embedded = await ordinaryBuildFile(root, "packages/dsh-plugin/assets/windows-x64/dsh-inochi2d-pet.exe");
  assertDesktopExecutable(embedded, manifest.executable);
  const built = await ordinaryBuildFile(root, "apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe");
  if (!embedded.equals(built)) throw Error("embedded Windows program differs from this release build");
  await checkPluginPackage(root, { allowLocalTest: localTest });
} catch (error) {
  failures.push(`starter character delivery is not ready: ${String(error)}`);
}
const tauriConfig = await jsonFile("apps/desktop/src-tauri/tauri.conf.json");
if (typeof tauriConfig?.productName !== "string" || !tauriConfig.productName) {
  failures.push("Tauri product name is missing");
} else {
  failures.push(...await checkReleaseInstaller(root, tauriConfig.productName, version));
}

try {
  const commandOptions = {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const status = execFileSync("git", ["status", "--porcelain"], commandOptions);
  if (status.trim()) failures.push("the release worktree is not clean");
  const remote = execFileSync("git", ["remote", "get-url", "origin"], commandOptions).trim();
  if (!/github\.com[/:]StarCried\/starlite-dsh(?:\.git)?$/iu.test(remote)) {
    failures.push("origin is not the public StarCried/starlite-dsh repository");
  }
} catch {
  failures.push("the public origin remote is not configured");
}

if (failures.length > 0) {
  console.error(`Release is blocked by ${failures.length} condition(s):\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(localTest ? `Local candidate ${version} passed build gates; this is NOT publication approval.` : `Release ${version} passed every local publication gate.`);
}

async function requiredFile(relativePath, minimumBytes) {
  const info = await stat(resolve(root, relativePath)).catch(() => undefined);
  if (!info?.isFile() || info.size < minimumBytes) failures.push(`required release file is missing: ${relativePath}`);
}

async function textFile(relativePath) {
  return readFile(resolve(root, relativePath), "utf8").catch(() => undefined);
}

async function jsonFile(relativePath) {
  const text = await textFile(relativePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    failures.push(`invalid JSON: ${relativePath}`);
    return undefined;
  }
}
