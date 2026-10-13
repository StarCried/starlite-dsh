import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

const LIMIT = 64 * 1024 * 1024;
const NOTICE_LIMIT = 8 * 1024 * 1024;
const EXECUTABLE = "dsh-inochi2d-pet.exe";
const NOTICES = ["LICENSE", "THIRD_PARTY_LICENSES.txt"] as const;

export interface CompanionManifest {
  readonly schemaVersion: 2;
  readonly version: string;
  readonly platform: "windows-x64";
  readonly executable: {readonly file: typeof EXECUTABLE; readonly sha256: string; readonly bytes: number};
  readonly defaultModel: {
    readonly title: string;
    readonly url: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly localTest?: true;
  };
}

export interface PrepareCompanionOptions {
  readonly assetDirectory: string;
  readonly cacheDirectory: string;
  readonly expectedVersion: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly acquireDefaultModel?: boolean;
}

export interface PreparedCompanion {
  readonly executable: string;
  readonly defaultModelReady: boolean;
}

/** Stage the program separately from the independently licensed VRM model. */
export async function prepareEmbeddedCompanion(options: PrepareCompanionOptions): Promise<PreparedCompanion> {
  options.signal?.throwIfAborted();
  const assets = await realpath(options.assetDirectory);
  const manifest = parseCompanionManifest(await ordinaryFile(assets, "manifest.json", 16_384), options.expectedVersion);
  const executable = await ordinaryFile(assets, EXECUTABLE, LIMIT);
  assertDigest(executable, manifest.executable);
  assertWindowsGuiExecutable(executable);
  const notices = await Promise.all(NOTICES.map(name => ordinaryFile(assets, name, NOTICE_LIMIT)));
  options.signal?.throwIfAborted();
  await ensureSafeDirectory(options.cacheDirectory);
  const cacheKey = createHash("sha256").update(`${manifest.executable.sha256}:${manifest.defaultModel.sha256}`).digest("hex");
  const directory = join(options.cacheDirectory, `${manifest.version}-${cacheKey}`);
  const descriptor = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    title: manifest.defaultModel.title,
    sha256: manifest.defaultModel.sha256,
    bytes: manifest.defaultModel.bytes,
    file: "default-model.vrm",
  }));
  if (!await exists(directory)) {
    const temporary = await mkdtemp(join(options.cacheDirectory, ".stage-"));
    try {
      await writeFile(join(temporary, EXECUTABLE), executable, {flag: "wx", mode: 0o700});
      for (const [index, name] of NOTICES.entries()) {
        await writeFile(join(temporary, name), notices[index]!, {flag: "wx", mode: 0o600});
      }
      // Keep the descriptor even when the external download fails, so the UI can explain/retry.
      await writeFile(join(temporary, "default-model.json"), descriptor, {flag: "wx", mode: 0o600});
      options.signal?.throwIfAborted();
      try { await rename(temporary, directory); }
      catch (error) { if (!await exists(directory)) throw error; }
    } finally { await rm(temporary, {recursive: true, force: true}); }
  }
  await assertSafeDirectory(directory);
  assertEqual(await ordinaryFile(directory, EXECUTABLE, LIMIT), executable);
  for (const [index, name] of NOTICES.entries()) assertEqual(await ordinaryFile(directory, name, NOTICE_LIMIT), notices[index]!);
  assertEqual(await ordinaryFile(directory, "default-model.json", 16_384), descriptor);
  options.signal?.throwIfAborted();
  if (options.acquireDefaultModel === false) return {executable: join(directory, EXECUTABLE), defaultModelReady: false};
  let defaultModelReady = false;
  try {
    const modelFile = join(directory, "default-model.vrm");
    if (await exists(modelFile)) {
      const cached = await ordinaryFile(directory, "default-model.vrm", LIMIT);
      try { assertDigest(cached, manifest.defaultModel); defaultModelReady = true; }
      catch { /* Only a bounded ordinary cache file may be repaired from the pinned source. */ }
    }
    if (!defaultModelReady) await downloadCharacter(manifest.defaultModel, directory, options.fetch ?? fetch, options.signal);
    defaultModelReady = true;
  } catch {
    options.signal?.throwIfAborted();
    // The desktop still starts and presents the explicit missing/invalid-character state.
  }
  options.signal?.throwIfAborted();
  return {executable: join(directory, EXECUTABLE), defaultModelReady};
}

export function parseCompanionManifest(bytes: Uint8Array, expectedVersion: string): CompanionManifest {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!record(value) || !keys(value, ["schemaVersion", "version", "platform", "executable", "defaultModel"])
    || value.schemaVersion !== 2 || value.platform !== "windows-x64"
    || typeof value.version !== "string" || value.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value.version)
    || value.version !== expectedVersion || !record(value.executable) || !keys(value.executable, ["file", "sha256", "bytes"])
    || value.executable.file !== EXECUTABLE || !digest(value.executable)
    || !record(value.defaultModel) || !keys(value.defaultModel, ["title", "url", "sha256", "bytes"], ["localTest"])
    || typeof value.defaultModel.title !== "string" || value.defaultModel.title.length < 1 || value.defaultModel.title.length > 128
    || /[\p{Cc}]/u.test(value.defaultModel.title) || !digest(value.defaultModel)
    || (value.defaultModel.localTest !== undefined && value.defaultModel.localTest !== true)
    || typeof value.defaultModel.url !== "string" || value.defaultModel.url.length > 2_048
    || /[\p{Cc}\\]/u.test(value.defaultModel.url)) {
    throw new Error("invalid embedded companion manifest");
  }
  const url = new URL(value.defaultModel.url);
  if (!url.pathname.toLowerCase().endsWith(".vrm") || url.username || url.password || url.hash || (url.protocol !== "https:"
    && !(value.defaultModel.localTest === true && url.protocol === "http:" && url.hostname === "127.0.0.1"
      && /^http:\/\/127\.0\.0\.1(?::\d+)?\//u.test(value.defaultModel.url)))) {
    throw new Error("invalid starter character download source");
  }
  return value as unknown as CompanionManifest;
}

export function assertWindowsGuiExecutable(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("invalid embedded Windows executable");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 94 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550
    || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 20) < 70
    || pe + 24 + bytes.readUInt16LE(pe + 20) > bytes.length || bytes.readUInt16LE(pe + 24) !== 0x20b
    || bytes.readUInt16LE(pe + 24 + 68) !== 2) throw new Error("embedded executable must be Windows x64 GUI PE32+");
}

async function downloadCharacter(source: CompanionManifest["defaultModel"], directory: string, request: typeof fetch, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(30_000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await request(source.url, {method: "GET", redirect: "error", signal: downloadSignal});
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error("starter character download failed");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== source.bytes)) {
    await response.body.cancel();
    throw new Error("starter character download size mismatch");
  }
  const temporary = join(directory, `.download-${randomUUID()}`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const reader = response.body.getReader();
  try {
    file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      downloadSignal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > source.bytes || bytes > LIMIT) throw new Error("starter character download exceeds its size limit");
      hash.update(item.value);
      await file.writeFile(item.value);
    }
    if (bytes !== source.bytes || hash.digest("hex") !== source.sha256) throw new Error("starter character download integrity mismatch");
    await file.sync();
    await file.close(); file = undefined;
    downloadSignal.throwIfAborted();
    const modelFile = join(directory, "default-model.vrm");
    if (await exists(modelFile)) {
      const cached = await ordinaryFile(directory, "default-model.vrm", LIMIT);
      try { assertDigest(cached, source); return; }
      catch { /* Replace only this validated ordinary cache file, after the replacement has passed its digest. */ }
    }
    await rename(temporary, modelFile);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close();
    await rm(temporary, {force: true});
  }
}

async function ordinaryFile(directory: string, name: string, limit: number): Promise<Buffer> {
  await assertSafeDirectory(directory);
  const path = join(directory, name), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error("unsafe companion file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== info.size || opened.size > limit) throw new Error("unsafe companion file");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("companion file changed while reading");
      offset += read.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (extra.bytesRead !== 0) throw new Error("companion file changed while reading");
    return bytes;
  } finally { await file.close(); }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("companion cache must be an absolute local directory");
  const absolute = resolve(directory), root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, {mode: 0o700}); }
    catch (error) { if (!record(error) || error.code !== "EEXIST") throw error; }
    await assertSafeDirectory(current);
  }
}

async function assertSafeDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe companion directory");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (record(error) && error.code === "ENOENT") return false; throw error; }
}

function assertDigest(bytes: Buffer, expected: {readonly bytes: number; readonly sha256: string}): void {
  if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("companion file integrity mismatch");
}
function assertEqual(actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new Error("cached companion file integrity mismatch");
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function digest(value: Record<string, unknown>): boolean {
  return typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256)
    && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 1 && value.bytes <= LIMIT;
}
