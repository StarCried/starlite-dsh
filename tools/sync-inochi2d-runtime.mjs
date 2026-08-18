import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceArgument = process.argv[2] ?? process.env.INOCHI2D_WEB_DIST;
if (!sourceArgument) {
  throw new Error(
    "runtime source is required: pnpm sync:runtime -- <inochi2d-web dist directory>",
  );
}
const source = resolve(sourceArgument);
const destination = resolve(
  workspaceRoot,
  "apps/desktop/public/runtime/inochi2d-web",
);

const destinationRelative = relative(workspaceRoot, destination);
if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative)) {
  throw new Error("runtime destination must remain inside the workspace");
}

await assertRuntime(source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyRuntimeTree(source, destination);
await copyRuntimeNotices(dirname(source), destination);
await writeRuntimeProvenance(source, destination);
await assertRuntime(destination);

console.log(`Copied the local Inochi2D runtime to ${destination}`);

async function assertRuntime(directory) {
  const required = [
    "index.js",
    "widget.css",
    "generated/inochi2d.wasm",
  ];
  for (const relative of required) {
    const file = resolve(directory, relative);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`missing runtime artifact: ${file}`);
  }
}

async function copyRuntimeTree(sourceDirectory, outputDirectory) {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(sourceDirectory, entry.name);
    const outputPath = resolve(outputDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime artifacts must not be symbolic links: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(outputPath, { recursive: true });
      await copyRuntimeTree(sourcePath, outputPath);
      continue;
    }
    if (entry.isFile() && /\.(?:css|js|wasm)$/u.test(entry.name)) {
      await copyFile(sourcePath, outputPath);
    }
  }
}

async function copyRuntimeNotices(packageRoot, output) {
  for (const name of ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"]) {
    const sourcePath = resolve(packageRoot, name);
    const info = await stat(sourcePath).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`runtime third-party notice is unavailable: ${sourcePath}`);
    }
    await copyFile(sourcePath, resolve(output, name));
  }
}

async function writeRuntimeProvenance(runtimeDist, output) {
  const packageRoot = dirname(runtimeDist);
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const repositoryRoot = await git(runtimeDist, ["rev-parse", "--show-toplevel"]);
  const revision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const status = await git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const remote = await git(repositoryRoot, ["remote", "get-url", "origin"]).catch(() => "");
  const sdkPin = JSON.parse(
    await readFile(resolve(repositoryRoot, "tools/official-sdk/pin.json"), "utf8"),
  );
  const dubSelections = JSON.parse(
    await readFile(resolve(repositoryRoot, "tools/official-sdk/dub.selections.json"), "utf8"),
  );
  const wasm = await readFile(resolve(output, "generated/inochi2d.wasm"));
  const wasmSha256 = createHash("sha256").update(wasm).digest("hex");
  if (wasmSha256 !== sdkPin.optimizedWasmSha256) {
    throw new Error("staged runtime WASM does not match the pinned official SDK build");
  }
  const provenance = {
    schemaVersion: 1,
    package: packageJson.name,
    version: packageJson.version,
    repository: remote || null,
    revision,
    dirty: status.length > 0,
    officialSdk: {
      repository: "https://github.com/Inochi2D/inochi2d",
      revision: sdkPin.sdkCommit,
      wasmSha256,
      packages: dubSelections.versions,
    },
  };
  await writeFile(
    resolve(output, "runtime-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );
}

async function git(directory, arguments_) {
  // `safe.directory=*` applies only to this process. It permits provenance
  // capture from a WSL UNC checkout without changing the user's Git config.
  const { stdout } = await execFile(
    "git",
    ["-c", "safe.directory=*", "-C", directory, ...arguments_],
    { encoding: "utf8", windowsHide: true },
  );
  return stdout.trim();
}
