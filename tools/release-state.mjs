import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const REPOSITORY = "StarCried/starlite-dsh";
export const PACKAGE = "dsh-starlite";
export const VERSION_FILES = ["package.json", "apps/desktop/package.json", "packages/protocol/package.json", "tools/mock-source/package.json", "apps/desktop/src-tauri/tauri.conf.json"];
export const CURRENT_DOCS = ["README.md", "README.en.md", "packages/dsh-plugin/README.md", "packages/dsh-plugin/README.en.md", "docs/user-guide.md", "docs/user-guide.en.md"];
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const json = async path => JSON.parse(await readFile(path, "utf8"));
export const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export function compareVersions(left, right) {
  const split = value => { const [main, ...pre] = value.split("-"); return {main: main.split(".").map(Number), pre: pre.join("-").split(".").filter(Boolean)}; };
  const a = split(left), b = split(right);
  for (let index = 0; index < 3; index++) if (a.main[index] !== b.main[index]) return a.main[index] - b.main[index];
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export async function syncVersions(root, { write = false } = {}) {
  const {version} = await json(resolve(root, "packages/dsh-plugin/package.json"));
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu.test(version)) throw Error("Invalid public package version");
  const mismatches = [];
  for (const file of VERSION_FILES) {
    const data = await json(resolve(root, file));
    if (data.version === version) continue;
    if (write) await writeJson(resolve(root, file), {...data, version});
    else mismatches.push(file);
  }
  for (const [file, pattern] of [
    ["apps/desktop/src-tauri/Cargo.toml", /(^version\s*=\s*")[^"]+("\s*$)/mu],
    ["apps/desktop/src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "dsh-inochi2d-pet"\r?\nversion = ")[^"]+(")/u],
  ]) {
    const text = await readFile(resolve(root, file), "utf8");
    if (!pattern.test(text)) throw Error(`Missing owned version: ${file}`);
    const updated = text.replace(pattern, (_, before, after) => `${before}${version}${after}`);
    if (text === updated) continue;
    if (write) await writeFile(resolve(root, file), updated);
    else mismatches.push(file);
  }
  if (mismatches.length) throw Error(`Run pnpm release version to synchronize ${version}: ${mismatches.join(", ")}`);
  return version;
}

// Current install guides only: historical release records and fixtures are intentionally excluded.
export async function checkCurrentDocs(root, version) {
  for (const file of CURRENT_DOCS) {
    const text = await readFile(resolve(root, file), "utf8");
    for (const match of text.matchAll(/(?:正式版\s*`|Release\s*`|This guide covers\s*`|dsh-starlite@)(\d+\.\d+\.\d+(?:-[\da-z.-]+)?)/giu)) {
      if (match[1] !== version) throw Error(`${file} recommends stale version ${match[1]} (current ${version})`);
    }
  }
}

export function docsOnly(paths) {
  return paths.length > 0 && paths.every(path => /^(?:README(?:\.en)?\.md|CHANGELOG\.md|AGENTS\.md|docs\/.*\.md|release\/README\.md|packages\/[^/]+\/(?:README(?:\.en)?|CHANGELOG)\.md)$/u.test(path));
}

export function assertPreparedRun(run, manifest) {
  if (run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY || run.path !== ".github/workflows/release.yml" || run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success" || !/^[a-f0-9]{40}$/u.test(run.head_sha)) throw Error("Expected a successful main preparation run from this repository");
  if (manifest && (manifest.repository !== REPOSITORY || manifest.sourceRevision !== run.head_sha)) throw Error("Prepared manifest does not match the workflow source revision");
  return run.head_sha;
}

export async function verifyFiles(manifest, directory) {
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || !/^[a-f0-9]{40}$/u.test(manifest.sourceRevision)) throw Error("Invalid release manifest source");
  if (manifest.tag !== `v${manifest.version}` || !["latest", "alpha"].includes(manifest.channel)) throw Error("Invalid release identity");
  if (!/^[a-f0-9]{40}$/u.test(manifest.runtimeRevision)) throw Error("Invalid runtime pin");
  if (!Array.isArray(manifest.files) || manifest.files.length !== 7 || new Set(manifest.files.map(item => item.file)).size !== 7) throw Error("Expected seven unique release files");
  const names = [`dsh-starlite-${manifest.version}.tgz`, `StarLite-for-DSH_${manifest.version}_x64-setup.exe`, `StarLite-for-DSH_${manifest.version}_x64-portable.zip`, "SOURCE_REVISION", "sbom.cdx.json", "THIRD_PARTY_LICENSES.txt", "SHA256SUMS"];
  if (manifest.files.some(item => !names.includes(item.file))) throw Error("Unexpected release filename");
  for (const item of manifest.files) {
    if (basename(item.file) !== item.file || item.file.includes("\\")) throw Error("Release files must use flat names");
    const bytes = await readFile(resolve(directory, item.file));
    if (item.bytes !== bytes.length || item.sha256 !== digest(bytes)) throw Error(`Release file changed: ${item.file}`);
  }
  if (manifest.packages?.length !== 1 || manifest.packages[0].name !== PACKAGE || manifest.packages[0].version !== manifest.version) throw Error("Expected one public DSH package");
  const pkg = manifest.packages[0], file = manifest.files.find(item => item.file === pkg.file);
  if (!file || pkg.sha256 !== file.sha256 || pkg.bytes !== file.bytes || pkg.integrity !== integrity(await readFile(resolve(directory, pkg.file)))) throw Error("Package does not match reviewed release files");
  const source = (await readFile(resolve(directory, "SOURCE_REVISION"), "utf8")).trim();
  if (source !== manifest.sourceRevision) throw Error("Source revision does not match release manifest");
  return manifest;
}

export async function anonymous(url) {
  const response = await fetch(url, {credentials: "omit", headers: {"Cache-Control": "no-cache"}, signal: AbortSignal.timeout(30_000)});
  if (response.status === 404) return undefined;
  if (!response.ok) throw Error(`Public download failed: HTTP ${response.status} ${url}`);
  return response;
}

export async function registryPackage(pkg) {
  const response = await anonymous(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
  if (!response) return undefined;
  const metadata = await response.json();
  const url = new URL(metadata.dist.tarball);
  if (url.origin !== "https://registry.npmjs.org") throw Error("Unexpected registry archive origin");
  const archive = await anonymous(url.href);
  if (!archive) throw Error("Published package archive is unavailable");
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (bytes.length !== pkg.bytes || digest(bytes) !== pkg.sha256 || integrity(bytes) !== pkg.integrity) throw Error(`Published content conflicts: ${pkg.name}@${pkg.version}`);
  return metadata;
}
