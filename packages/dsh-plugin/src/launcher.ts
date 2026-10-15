import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { posix, win32 } from "node:path";
import { execFile, spawn } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareEmbeddedCompanion } from "./bootstrap.js";

export interface PetConnection {
  readonly port: number;
  readonly token: string;
  readonly instanceId?: string;
}

export interface LaunchOptions {
  readonly signal?: AbortSignal;
  readonly onDefaultModelFailure?: () => void;
  readonly host?: WindowsCompanionHost;
}

export type WindowsCompanionHost = "wsl" | "windows";

export function isWslEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.WSL_INTEROP || environment.WSL_DISTRO_NAME)
    || release().toLowerCase().includes("microsoft");
}

export function detectCompanionHost(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  inWsl: boolean = isWslEnvironment(),
): WindowsCompanionHost | undefined {
  if (architecture !== "x64") return undefined;
  if (platform === "win32") return "windows";
  return platform === "linux" && inWsl ? "wsl" : undefined;
}

/** Child processes need OS launch variables, never provider or Electron/Node options. */
export function companionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "WSL_INTEROP", "WSL_DISTRO_NAME"]) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  return result;
}

/** Start the embedded Windows companion; no installer, registry lookup or elevation. */
export async function launchWindowsPet(connection: PetConnection, options: LaunchOptions = {}): Promise<void> {
  const url = buildConnectionUrl(connection);
  const host = options.host ?? detectCompanionHost();
  if (!host) throw new Error("StarLite requires a Windows x64 or WSL2 x64 DSH Host");
  const paths = host === "windows" ? win32 : posix;
  options.signal?.throwIfAborted();
  let executable: string;
  const override = process.env.DSH_INOCHI2D_PET_EXE;
  if (override !== undefined) {
    const local = validateExecutableOverride(override);
    executable = host === "windows" ? local : (await execFileText("wslpath", ["-u", local], options.signal)).trim();
  } else {
    const windowsDirectories = (await execFileText("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('LocalApplicationData'); [Environment]::GetFolderPath('ApplicationData')",
    ], options.signal)).trim().split(/\r?\n/u);
    if (windowsDirectories.length !== 2 || windowsDirectories.some(path => !validWindowsDirectory(path))) throw new Error("Windows application directories are unavailable");
    const windowsCache = windowsDirectories[0]!;
    const localCache = host === "windows" ? windowsCache : (await execFileText("wslpath", ["-u", windowsCache], options.signal)).trim();
    const roaming = host === "windows" ? windowsDirectories[1]! : (await execFileText("wslpath", ["-u", windowsDirectories[1]!], options.signal)).trim();
    if (host === "wsl" && (!validPosixDirectory(localCache) || !validPosixDirectory(roaming))) throw new Error("invalid Windows application directories");
    const acquireDefaultModel = await shouldAcquireDefaultModel(paths.join(roaming, "com.starcried.dsh-inochi2d-pet", "settings.json"));
    const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error("invalid StarLite plugin package version");
    }
    const prepared = await prepareEmbeddedCompanion({
      assetDirectory: fileURLToPath(new URL("../assets/windows-x64/", import.meta.url)),
      cacheDirectory: paths.join(localCache, "StarCried", "StarLite", "companions"),
      expectedVersion: metadata.version,
      acquireDefaultModel,
      ...(options.signal ? {signal: options.signal} : {}),
    });
    executable = prepared.executable;
    if (acquireDefaultModel && !prepared.defaultModelReady) options.onDefaultModelFailure?.();
  }
  if ((host === "windows" && validateExecutableOverride(executable) !== executable)
    || (host === "wsl" && (!validPosixDirectory(executable) || posix.basename(executable).toLowerCase() !== "dsh-inochi2d-pet.exe"))) {
    throw new Error("StarLite for DSH executable is invalid");
  }
  options.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url], {
      // Windows' non-detached child job ends with the Host; the pet must retain
      // its own reconnect lease and any queued successor after that exit.
      detached: host === "windows",
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: companionEnvironment(process.env),
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => finish(error));
    child.once("spawn", () => finish());
    child.unref();
  });
}

function validWindowsDirectory(path: string): boolean {
  return /^[a-z]:[\\/]/iu.test(path) && win32.isAbsolute(path) && !/[\p{Cc}"<>|]/u.test(path)
    && !path.split(/[\\/]/u).some(part => part === "." || part === "..");
}

function validPosixDirectory(path: string): boolean {
  return posix.isAbsolute(path) && !/[\p{Cc}]/u.test(path) && !path.split("/").some(part => part === "." || part === "..");
}

/** Read only the selected-model policy; never transfer or log companion settings. */
export async function shouldAcquireDefaultModel(path: string): Promise<boolean> {
  const maximum = 4 * 1024 * 1024;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) return false;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size !== info.size) return false;
      const bytes = Buffer.alloc(info.size + 1);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== info.size) return false;
      const value: unknown = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      if (!("schemaVersion" in value)) return false;
      if (value.schemaVersion === 4) {
        return "activeModelId" in value && value.activeModelId === "weiguang-default";
      }
      if (![1, 2, 3].includes(value.schemaVersion as number)) return false;
      const preferences = "preferences" in value ? value.preferences : undefined;
      if (typeof preferences === "object" && preferences !== null && "modelEnabled" in preferences) return preferences.modelEnabled === true;
      return true;
    } finally { await file.close(); }
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}

/** A developer may explicitly select a local build, without changing registrations. */
export function validateExecutableOverride(override: string): string {
  if (!win32.isAbsolute(override)
    || !/^[a-z]:[\\/]/iu.test(override)
    || /[\p{Cc}"<>|]/u.test(override) || override.split(/[\\/]/u).some(part => part === "." || part === "..")
    || win32.basename(override).toLowerCase() !== "dsh-inochi2d-pet.exe") {
    throw new Error("DSH_INOCHI2D_PET_EXE must name a local Windows companion executable");
  }
  return override;
}

export function buildConnectionUrl(connection: PetConnection): string {
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
    throw new Error("invalid DSH pet status port");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(connection.token)) {
    throw new Error("invalid DSH pet connection token");
  }
  const instanceId = connection.instanceId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(instanceId)) {
    throw new Error("invalid DSH pet instance id");
  }
  const url = new URL("dsh-inochi2d-pet://connect");
  url.searchParams.set("port", String(connection.port));
  url.searchParams.set("token", connection.token);
  url.searchParams.set("instance", instanceId);

  return url.toString();
}

function execFileText(file: string, arguments_: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, arguments_, {
      encoding: "utf8",
      maxBuffer: 8_192,
      timeout: 3_000,
      windowsHide: true,
      env: companionEnvironment(process.env),
      ...(signal ? {signal} : {}),
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
