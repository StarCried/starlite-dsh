import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validDemoMappings } from "./release-mappings.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
import { RUNTIMES, assertRuntime } from "./model-runtime.mjs";
const versionFiles = [
  ["workspace", "package.json", "version"],
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

const pin = (await textFile("release/model-companion-web.rev"))?.trim();
if (!pin || !/^[0-9a-f]{40}$/u.test(pin)) {
  failures.push("release/model-companion-web.rev must contain one public 40-character Git revision");
}

for (const name of RUNTIMES) {
  try { await assertRuntime(name, resolve(root, "apps/desktop/public/runtime", name)); } catch (error) { failures.push(String(error)); }
  const metadata = await jsonFile(`apps/desktop/public/runtime/${name}/runtime-provenance.json`);
  if (!metadata || metadata.dirty !== false || metadata.revision !== pin) failures.push(`${name} must match the clean runtime pin`);
}
const provenance = await jsonFile("apps/desktop/public/runtime/inochi2d-web/runtime-provenance.json");
if (!provenance) {
  failures.push("the staged inochi2d-web runtime has no provenance");
} else {
  if (provenance.dirty !== false) failures.push("the staged inochi2d-web runtime is dirty");
  if (pin && provenance.revision !== pin) failures.push("runtime provenance does not match release/model-companion-web.rev");
  if (typeof provenance.repository !== "string" || !/github\.com[/:]StarCried\/inochi2d-web(?:\.git)?$/iu.test(provenance.repository)) {
    failures.push("runtime provenance does not name the public StarCried/inochi2d-web repository");
  }
  if (
    typeof provenance.officialSdk?.revision !== "string"
    || !/^[0-9a-f]{40}$/u.test(provenance.officialSdk.revision)
    || typeof provenance.officialSdk?.wasmSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(provenance.officialSdk.wasmSha256)
  ) {
    failures.push("runtime provenance lacks the pinned official SDK identity");
  }
}

const cargoRevision = cargo?.match(/inochi2d-pipeline\s*=\s*\{[^\n]*rev\s*=\s*"([0-9a-f]{40})"/u)?.[1];
if (!cargoRevision) failures.push("inochi2d-pipeline must use a fixed Git revision");
const pipelinePin = (await textFile("release/inochi2d-pipeline.rev"))?.trim();
if (!/^[0-9a-f]{40}$/u.test(pipelinePin ?? "") || pipelinePin !== cargoRevision) failures.push("inochi2d-pipeline revision differs from its release pin");

await requiredFile("assets/microlight/model.inp", 1);
const demoDefaults = await jsonFile("assets/microlight/defaults.json");
if (!demoDefaults || !validDemoMappings(demoDefaults.mappings)) {
  failures.push("MicroLight requires valid exact-name mappings in assets/microlight/defaults.json");
}
const assetLicense = await textFile("assets/microlight/ASSET_LICENSE.md");
if (!assetLicense || assetLicense.length < 120) {
  failures.push("MicroLight requires a complete assets/microlight/ASSET_LICENSE.md");
} else {
  if (!/SPDX-License-Identifier:/u.test(assetLicense)) failures.push("MicroLight license lacks an SPDX identifier");
  if (!/redistribut|再分发/iu.test(assetLicense)) failures.push("MicroLight license does not explicitly address redistribution");
}
for (const name of ["model.inp", "defaults.json", "ASSET_LICENSE.md"]) {
  await requireIdenticalFiles(
    `assets/microlight/${name}`,
    `apps/desktop/src-tauri/resources/microlight/${name}`,
  );
}

const version = versions[0]?.[1] ?? "unknown";
await requiredFile(`packages/dsh-plugin/.pack/dsh-inochi2d-pet-${version}.tgz`, 1);
const nsisDirectory = resolve(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
const installerNames = await readdir(nsisDirectory).catch(() => []);
const installerName = installerNames.find((name) => name.toLowerCase().endsWith("-setup.exe"));
if (!installerName) {
  failures.push("the unsigned NSIS release installer has not been built");
} else {
  const installer = await stat(resolve(nsisDirectory, installerName));
  const inputs = [
    ...RUNTIMES.map(name => `apps/desktop/public/runtime/${name}/runtime-provenance.json`),
    "apps/desktop/src-tauri/resources/microlight/model.inp",
    "apps/desktop/src-tauri/resources/microlight/defaults.json",
    "apps/desktop/src-tauri/resources/microlight/ASSET_LICENSE.md",
  ];
  for (const input of inputs) {
    const inputInfo = await stat(resolve(root, input)).catch(() => undefined);
    if (inputInfo && inputInfo.mtimeMs > installer.mtimeMs) {
      failures.push(`the NSIS installer is older than release input: ${input}`);
    }
  }
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
  if (!/github\.com[/:]StarCried\/dsh-inochi2d-pet(?:\.git)?$/iu.test(remote)) {
    failures.push("origin is not the public StarCried/dsh-inochi2d-pet repository");
  }
} catch {
  failures.push("the public origin remote is not configured");
}

if (failures.length > 0) {
  console.error(`Release is blocked by ${failures.length} condition(s):\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Release ${version} passed every local publication gate.`);
}

async function requiredFile(relativePath, minimumBytes) {
  const info = await stat(resolve(root, relativePath)).catch(() => undefined);
  if (!info?.isFile() || info.size < minimumBytes) failures.push(`required release file is missing: ${relativePath}`);
}

async function requireIdenticalFiles(source, staged) {
  const [left, right] = await Promise.all([
    readFile(resolve(root, source)).catch(() => undefined),
    readFile(resolve(root, staged)).catch(() => undefined),
  ]);
  if (!left || !right || !left.equals(right)) {
    failures.push(`staged release resource does not match ${source}`);
  }
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
