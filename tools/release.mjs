import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCurrentDocs, compareVersions, digest, integrity, json, PACKAGE, REPOSITORY, registryPackage, syncVersions, verifyFiles, windowsPackageManagerScript, writeJson, anonymous } from "./release-state.mjs";
import { assertDefaultModelCatalog } from "./plugin-desktop-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter(arg => arg !== "--");
const command = args.shift(), options = {};
while (args.length) {
  const key = args.shift();
  if (key === "--dry-run") options.dryRun = true;
  else if (["--out", "--output", "--manifest", "--dsh", "--core-source"].includes(key) && args[0] && !args[0].startsWith("--")) options[key === "--out" ? "output" : key.slice(2)] = args.shift();
  else throw Error(`Unknown release option: ${key}`);
}
if (options.dryRun && !["prepare", "publish", "verify"].includes(command)) throw Error("--dry-run is only supported by prepare, publish and verify");
function run(executable, argv, cwd = root, env = process.env, capture = false) {
  // Execute package-manager JS directly on Windows; no shell interpolation of paths.
  if (process.platform === "win32" && ["npm", "pnpm"].includes(executable)) {
    const where = execFileSync("where.exe", [`${executable}.cmd`], {encoding: "utf8", windowsHide: true}).trim().split(/\r?\n/u)[0];
    const script = windowsPackageManagerScript(executable, where, env.npm_execpath);
    argv = [script, ...argv]; executable = process.execPath;
  }
  return execFileSync(executable, argv, {cwd, env, encoding: "utf8", windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 32 * 1024 * 1024})?.trim();
}
const git = (argv, cwd = root) => run("git", argv, cwd, process.env, true);
const node = (script, argv = [], cwd = root, env = process.env) => run(process.execPath, [script, ...argv], cwd, env);

async function doctor() {
  const version = await syncVersions(root);
  await checkCurrentDocs(root, version);
  const pin = (await readFile(join(root, "release/starlite.rev"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/u.test(pin)) throw Error("Invalid shared runtime pin");
  const catalog = assertDefaultModelCatalog(await json(join(root, "release/default-models.json")));
  if (catalog.defaultModels.some(model => model.localTest)) throw Error("Release catalog contains a local model");
  return {version, pin, sourceRevision: git(["rev-parse", "HEAD"]), clean: !git(["status", "--porcelain"])};
}

function buildTools() {
  const versions = {};
  for (const tool of ["git", "npm", "pnpm", "cargo"]) versions[tool] = run(tool, ["--version"], root, process.env, true);
  versions.cargoAudit = process.env.CARGO_AUDIT_BIN ? run(process.env.CARGO_AUDIT_BIN, ["--version"], root, process.env, true) : run("cargo", ["audit", "--version"], root, process.env, true);
  return versions;
}

async function prepare() {
  const state = await doctor();
  const output = resolve(options.output ?? join(root, "release-output", `v${state.version}`));
  const steps = ["clone clean DSH source", "clone shared source at release/starlite.rev", "npm ci + build core/vrm", "sync freshly built runtimes", "pnpm check:core + Rust fmt/clippy/test + dependency audit", "Tauri build", "stage public catalog + pack plugin/portable + public release gate", "write reviewed release-manifest.json and seven flat assets"];
  if (options.dryRun) { console.log(JSON.stringify({...state, output, steps, canPrepare: state.clean}, null, 2)); return; }
  if (process.platform !== "win32") throw Error("Windows release preparation requires Windows x64");
  if (!state.clean) throw Error("Commit reviewed changes before prepare; source worktree must be clean");
  buildTools();
  // Never re-use a previous release's dist, staging files, or manifest.
  await mkdir(dirname(output), {recursive: true});
  await mkdir(output);
  const checkout = join(output, "checkout"), core = join(output, "starlite");
  run("git", ["clone", "--no-hardlinks", "--no-checkout", root, checkout]);
  git(["checkout", "--detach", state.sourceRevision], checkout);
  git(["remote", "set-url", "origin", `https://github.com/${REPOSITORY}.git`], checkout);
  run("git", ["clone", "--no-checkout", options["core-source"] ?? "https://github.com/StarCried/starlite.git", core]);
  git(["checkout", "--detach", state.pin], core);
  git(["remote", "set-url", "origin", "https://github.com/StarCried/starlite.git"], core);
  if (git(["status", "--porcelain"], core)) throw Error("Shared source is dirty");
  run("npm", ["ci"], core);
  for (const name of ["core", "vrm"]) run("npm", ["run", "build", "--workspace", `@starcried/starlite-${name}`], core);
  const env = {...process.env, STARLITE_SOURCE: core, CARGO_TARGET_DIR: join(checkout, "apps/desktop/src-tauri/target")};
  run("pnpm", ["install", "--frozen-lockfile"], checkout, env);
  node("tools/sync-model-runtime.mjs", [], checkout, env);
  run("pnpm", ["check:core"], checkout, env);
  const cargo = ["--manifest-path", "apps/desktop/src-tauri/Cargo.toml"];
  run("cargo", ["fmt", "--check", ...cargo], checkout, env);
  run("cargo", ["clippy", "--locked", ...cargo, "--all-targets", "--", "-D", "warnings"], checkout, env);
  run("cargo", ["clippy", "--locked", "--release", ...cargo, "--", "-D", "warnings"], checkout, env);
  run("cargo", ["test", "--locked", ...cargo], checkout, env);
  run("pnpm", ["check:dependencies"], checkout, env);
  run("pnpm", ["desktop:build"], checkout, env);
  const built = "apps/desktop/src-tauri/target/release";
  run("pnpm", ["release:metadata", "--", `${built}/dsh-inochi2d-pet.exe`], checkout, env);
  run("pnpm", ["stage:plugin", "--", "release/default-models.json"], checkout, env);
  run("pnpm", ["pack:plugin"], checkout, env);
  run("pnpm", ["pack:portable"], checkout, env);
  run("pnpm", ["check:release"], checkout, env);
  const version = state.version;
  const sources = [
    [`packages/dsh-plugin/.pack/${PACKAGE}-${version}.tgz`, `${PACKAGE}-${version}.tgz`],
    [`${built}/bundle/nsis/StarLite for DSH_${version}_x64-setup.exe`, `StarLite-for-DSH_${version}_x64-setup.exe`],
    [`release-output/StarLite-for-DSH_${version}_x64-portable.zip`, `StarLite-for-DSH_${version}_x64-portable.zip`],
    ["release-output/sbom.cdx.json", "sbom.cdx.json"],
    ["release-output/THIRD_PARTY_LICENSES.txt", "THIRD_PARTY_LICENSES.txt"],
  ];
  for (const [from, to] of sources) await copyFile(join(checkout, from), join(output, to));
  await writeFile(join(output, "SOURCE_REVISION"), `${state.sourceRevision}\n`);
  const files = [];
  for (const file of [...sources.map(item => item[1]), "SOURCE_REVISION"]) {
    const bytes = await readFile(join(output, file)); files.push({file, bytes: bytes.length, sha256: digest(bytes)});
  }
  const sums = Buffer.from(`${files.map(file => `${file.sha256}  ${file.file}`).sort().join("\n")}\n`);
  await writeFile(join(output, "SHA256SUMS"), sums);
  files.push({file: "SHA256SUMS", bytes: sums.length, sha256: digest(sums)});
  const pkg = {...files[0], name: PACKAGE, version, integrity: integrity(await readFile(join(output, files[0].file)))};
  const changelog = await readFile(join(checkout, "packages/dsh-plugin/CHANGELOG.md"), "utf8");
  const notes = changelog.split(new RegExp(`^## ${version.replaceAll(".", "\\.")}\\s*$`, "mu"))[1]?.split(/^## /mu)[0]?.trim();
  if (!notes) throw Error("Changesets changelog lacks this release; do not publish without reviewed release notes");
  await writeJson(join(output, "release-manifest.json"), {schemaVersion: 1, repository: REPOSITORY, sourceRevision: state.sourceRevision, runtimeRevision: state.pin, version, tag: `v${version}`, channel: version.includes("-") ? "alpha" : "latest", packages: [pkg], files, notes, checks: {localReleaseGate: true, sourceClean: true, runtimeBuiltFromPin: true, installerLifecycle: "separate CI check"}});
  console.log(`Prepared ${join(output, "release-manifest.json")}; no publishing performed.`);
}

async function checkTag(manifest) {
  const response = await anonymous(`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${manifest.tag}`);
  if (!response) return;
  let reference = await response.json();
  if (reference.object.type === "tag") reference = await (await anonymous(reference.object.url)).json();
  if (reference.object.type !== "commit" || reference.object.sha !== manifest.sourceRevision) throw Error("Existing release tag targets different source");
}

async function githubRelease(manifest, authenticated = false) {
  let release;
  if (authenticated) {
    try {
      // gh release view also finds pending-tag drafts; REST /releases/tags alone does not.
      const {databaseId} = JSON.parse(run("gh", ["release", "view", manifest.tag, "--repo", REPOSITORY, "--json", "databaseId"], root, process.env, true));
      release = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/releases/${databaseId}`], root, process.env, true));
    } catch (error) { if (!/release not found|404/iu.test(String(error.stderr))) throw error; return undefined; }
  } else {
    const response = await anonymous(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${manifest.tag}`);
    if (!response) return undefined;
    release = await response.json();
  }
  if (release.draft && release.target_commitish !== manifest.sourceRevision) throw Error("Draft release targets different source");
  for (const asset of release.assets) {
    const expected = manifest.files.find(file => file.file === asset.name);
    if (!expected) throw Error(`Unexpected existing release asset: ${asset.name}`);
    const bytes = release.draft ? execFileSync("gh", ["api", `repos/${REPOSITORY}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], {cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024})
      : Buffer.from(await (await anonymous(asset.browser_download_url)).arrayBuffer());
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw Error(`Published asset conflicts: ${asset.name}`);
  }
  return release;
}

async function deliver(publish) {
  if (!options.manifest) throw Error("Pass --manifest /path/release-manifest.json");
  const path = resolve(options.manifest), directory = dirname(path);
  const manifest = await verifyFiles(await json(path), directory);
  const pinResponse = await anonymous(`https://api.github.com/repos/${REPOSITORY}/contents/release/starlite.rev?ref=${manifest.sourceRevision}`);
  if (!pinResponse) throw Error("Release source must be public before publishing");
  const pinned = await pinResponse.json();
  if (Buffer.from(pinned.content, "base64").toString("utf8").trim() !== manifest.runtimeRevision) throw Error("Manifest runtime pin differs from public release source");
  if (!await anonymous(`https://api.github.com/repos/StarCried/starlite/git/commits/${manifest.runtimeRevision}`)) throw Error("Pinned shared runtime source must be public before publishing");
  // Read-only checks happen before any publication. Never rebuild or repack here.
  const existing = await registryPackage(manifest.packages[0]);
  await checkTag(manifest);
  let release = await githubRelease(manifest, publish);
  if (release && !release.draft && release.assets.length !== manifest.files.length) throw Error("Existing public release is incomplete; do not modify an immutable release");
  const tagUrl = `https://registry.npmjs.org/${PACKAGE}/${manifest.channel}`;
  let tag = await (await anonymous(tagUrl))?.json();
  if (tag && compareVersions(tag.version, manifest.version) > 0) throw Error(`Refusing to move ${manifest.channel} backwards from ${tag.version}`);
  if (options.dryRun) { console.log(JSON.stringify({version: manifest.version, npmExistsIdentically: Boolean(existing), githubExists: Boolean(release), files: manifest.files.map(file => file.file), publish: false}, null, 2)); return; }
  if (publish) {
    if (!existing) run("npm", ["publish", join(directory, manifest.packages[0].file), "--tag", manifest.channel, "--access", "public", "--ignore-scripts"], root);
    if (!release) {
      const notes = join(directory, "release-notes.md"); await writeFile(notes, manifest.notes);
      run("gh", ["release", "create", manifest.tag, "--draft", "--repo", REPOSITORY, "--target", manifest.sourceRevision, "--title", `StarLite for DSH ${manifest.version}`, "--notes-file", notes, ...(manifest.channel === "alpha" ? ["--prerelease"] : [])]);
      release = {assets: [], draft: true};
    }
    const missing = manifest.files.filter(file => !release.assets.some(asset => asset.name === file.file));
    if (missing.length) run("gh", ["release", "upload", manifest.tag, ...missing.map(file => join(directory, file.file)), "--repo", REPOSITORY]);
    if (release.draft) {
      const draft = await githubRelease(manifest, true);
      if (draft.assets.length !== manifest.files.length) throw Error("Draft assets are incomplete");
      run("gh", ["release", "edit", manifest.tag, "--draft=false", "--repo", REPOSITORY]);
    }
  }
  let available;
  for (let attempt = 0; attempt < (publish ? 12 : 1); attempt++) {
    available = await registryPackage(manifest.packages[0]);
    if (available) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!available) throw Error("Registry not visible yet; rerun verify (do not rebuild)");
  tag = await (await anonymous(tagUrl))?.json();
  if (tag?.version !== manifest.version && publish) {
    run("npm", ["dist-tag", "add", `${PACKAGE}@${manifest.version}`, manifest.channel]);
    tag = await (await anonymous(tagUrl))?.json();
  }
  if (tag?.version !== manifest.version) throw Error(`Registry ${manifest.channel} does not identify this release`);
  await checkTag(manifest);
  release = await githubRelease(manifest);
  if (!release || release.draft || release.assets.length !== manifest.files.length) throw Error("GitHub release is missing public assets");
  if (options.dsh) node("tools/verify-registry-install.mjs", [path, resolve(options.dsh)]);
  await writeJson(join(directory, "publication-result.json"), {checkedAt: new Date().toISOString(), version: manifest.version, sourceRevision: manifest.sourceRevision, runtimeRevision: manifest.runtimeRevision, npm: true, github: true, anonymousDownloads: true, registryInstall: options.dsh ? process.platform : "not-run"});
  console.log(`Verified public ${manifest.version} against the reviewed manifest.`);
}

switch (command) {
  case "doctor": console.log(JSON.stringify({...await doctor(), tools: buildTools()}, null, 2)); break;
  case "plan": run("pnpm", ["exec", "changeset", "status"]); break;
  case "version":
    run("pnpm", ["exec", "changeset", "version"]);
    await syncVersions(root, {write: true});
    run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
    await checkCurrentDocs(root, await syncVersions(root));
    break;
  case "prepare": await prepare(); break;
  case "publish": await deliver(true); break;
  case "verify": await deliver(false); break;
  default: throw Error("Usage: pnpm release <doctor|plan|version|prepare|publish|verify> [--out dir|--manifest file] [--dry-run] [--core-source checkout] [--dsh official-package-directory]");
}
