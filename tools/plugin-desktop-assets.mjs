import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPortableExecutable } from "./pack-portable.mjs";

export const DESKTOP_ASSET_DIRECTORY = "packages/dsh-plugin/assets/windows-x64";
export const DESKTOP_ASSET_FILES = ["dsh-inochi2d-pet.exe", "LICENSE", "THIRD_PARTY_LICENSES.txt", "manifest.json"];
export const MAX_DESKTOP_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u;

function record(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw Error("invalid desktop asset manifest fields");
}
function boundedBytes(value) { return Number.isSafeInteger(value) && value > 0 && value <= MAX_DESKTOP_BYTES; }

export function assertStarterCharacter(value, { allowLocalTest = true } = {}) {
  record(value, ["title", "url", "sha256", "bytes", "modelSha256", "localTest"], ["title", "url", "sha256", "bytes", "modelSha256"]);
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120 || [...value.title].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
    || typeof value.url !== "string" || value.url.length > 2048 || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || typeof value.modelSha256 !== "string" || !HASH.test(value.modelSha256) || !boundedBytes(value.bytes)) throw Error("invalid starter character identity or bounds");
  const url = new URL(value.url);
  if (url.username || url.password || url.search || url.hash) throw Error("starter character URL must not contain credentials, queries or fragments");
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
  record(value, ["schemaVersion", "version", "platform", "executable", "starterCharacter"]);
  record(value.executable, ["file", "sha256", "bytes"]);
  if (value.schemaVersion !== 1 || value.platform !== "windows-x64" || typeof value.version !== "string" || !VERSION.test(value.version)
    || (expectedVersion !== undefined && value.version !== expectedVersion)
    || value.executable.file !== "dsh-inochi2d-pet.exe" || typeof value.executable.sha256 !== "string" || !HASH.test(value.executable.sha256)
    || !boundedBytes(value.executable.bytes)) throw Error("invalid desktop executable identity or version");
  assertStarterCharacter(value.starterCharacter, { allowLocalTest });
  return value;
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
