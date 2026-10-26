import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPortableExecutable } from "./pack-portable.mjs";

export const DESKTOP_ASSET_DIRECTORY = "packages/dsh-plugin/assets/windows-x64";
export const DESKTOP_ASSET_FILES = ["dsh-inochi2d-pet.exe", "LICENSE", "THIRD_PARTY_LICENSES.txt", "manifest.json"];
export const MAX_DESKTOP_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u;

function record(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw Error("invalid desktop asset manifest fields");
}
function boundedBytes(value) { return Number.isSafeInteger(value) && value > 0 && value <= MAX_DESKTOP_BYTES; }

export function assertDefaultModel(value, { allowLocalTest = true } = {}) {
  record(value, ["title", "url", "sha256", "bytes", "localTest"], ["title", "url", "sha256", "bytes"]);
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120 || [...value.title].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
    || typeof value.url !== "string" || value.url.length > 2048 || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || !boundedBytes(value.bytes)) throw Error("invalid starter character identity or bounds");
  const url = new URL(value.url);
  if (!url.pathname.toLowerCase().endsWith(".vrm") || url.username || url.password || url.search || url.hash) throw Error("starter character URL must not contain credentials, queries or fragments");
  if (value.localTest === true) {
    if (!allowLocalTest || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
      throw Error("local-test character source cannot be publicly released");
    }
  } else if (Object.hasOwn(value, "localTest") || url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw Error("public starter character source must use HTTPS");
  }
  return value;
}

export function assertDesktopManifest(value, { allowLocalTest = true, expectedVersion } = {}) {
  record(value, ["schemaVersion", "version", "platform", "executable", value?.schemaVersion === 3 ? "defaultModels" : "defaultModel"]);
  record(value.executable, ["file", "sha256", "bytes"]);
  if (![2,3].includes(value.schemaVersion) || value.platform !== "windows-x64" || typeof value.version !== "string" || !VERSION.test(value.version)
    || (expectedVersion !== undefined && value.version !== expectedVersion)
    || value.executable.file !== "dsh-inochi2d-pet.exe" || typeof value.executable.sha256 !== "string" || !HASH.test(value.executable.sha256)
    || !boundedBytes(value.executable.bytes)) throw Error("invalid desktop executable identity or version");
  if (value.schemaVersion === 2) assertDefaultModel(value.defaultModel, { allowLocalTest });
  else assertDefaultModelCatalog({schemaVersion:3,defaultModels:value.defaultModels}, {allowLocalTest});
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) throw Error("desktop manifest exceeds its size limit");
  return value;
}

/** Catalogs contain metadata only; model bytes stay outside every program artifact. */
export function assertDefaultModelCatalog(value, {allowLocalTest = true} = {}) {
  record(value, ["schemaVersion", "defaultModels"]);
  if (value.schemaVersion !== 3 || !Array.isArray(value.defaultModels) || value.defaultModels.length < 1 || value.defaultModels.length > 2) throw Error("invalid default model catalog");
  const ids = new Set();
  for (const model of value.defaultModels) {
    record(model, ["id","title","url","sha256","bytes","license","localTest"], ["id","title","url","sha256","bytes","license"]);
    if (!["weiguang-default","bluefish-default"].includes(model.id) || ids.has(model.id)) throw Error("invalid or duplicate default model identifier");
    ids.add(model.id);
    const {id: _id, license, ...source} = model;
    assertDefaultModel(source, {allowLocalTest});
    record(license, ["title","text"]);
    if (typeof license.title !== "string" || !license.title.trim() || license.title.length > 128 || /[\p{Cc}]/u.test(license.title)
      || typeof license.text !== "string" || !license.text.trim() || Buffer.byteLength(license.text) > 100 * 1024 || license.text.includes("\0")) throw Error("invalid default model license");
  }
  if (!ids.has("weiguang-default")) throw Error("default model catalog must retain Weiguang");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) throw Error("default model catalog exceeds its size limit");
  return value;
}

export function manifestDefaultModels(manifest) {
  return manifest.schemaVersion === 2 ? [manifest.defaultModel] : manifest.defaultModels;
}

export function assertDesktopExecutable(bytes, expected) {
  assertPortableExecutable(bytes);
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw Error("embedded desktop executable size or SHA-256 mismatch");
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Refuse symlinks and redirected parent directories before reading a build input. */
export async function ordinaryBuildFile(root, relativePath, maximum = MAX_DESKTOP_BYTES) {
  let path = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; ++index) {
    path = join(path, segments[index]);
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw Error(`desktop input is missing or unsafe: ${relativePath}`);
    }
    if (index === segments.length - 1 && (info.size === 0 || info.size > maximum)) throw Error(`desktop input has an invalid size: ${relativePath}`);
  }
  return readFile(path);
}
