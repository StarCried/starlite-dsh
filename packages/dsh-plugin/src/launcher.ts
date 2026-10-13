import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { basename, join, win32 } from "node:path";
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
  readonly onStarterFailure?: () => void;
}

export function isWslEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.WSL_INTEROP || environment.WSL_DISTRO_NAME)
    || release().toLowerCase().includes("microsoft");
}

/** Start the embedded Windows companion; no installer, registry lookup or elevation. */
export async function launchWindowsPet(connection: PetConnection, options: LaunchOptions = {}): Promise<void> {
  const url = buildConnectionUrl(connection);
  options.signal?.throwIfAborted();
  let executable: string;
  const override = process.env.DSH_INOCHI2D_PET_EXE;
  if (override !== undefined) {
    executable = (await execFileText("wslpath", ["-u", validateExecutableOverride(override)], options.signal)).trim();
  } else {
    const windowsDirectories = (await execFileText("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('LocalApplicationData'); [Environment]::GetFolderPath('ApplicationData')",
    ], options.signal)).trim().split(/\r?\n/u);
    if (windowsDirectories.length !== 2 || windowsDirectories.some(path => !validWindowsDirectory(path))) throw new Error("Windows application directories are unavailable");
    const windowsCache = windowsDirectories[0]!;
    const localCache = (await execFileText("wslpath", ["-u", windowsCache], options.signal)).trim();
    if (!localCache.startsWith("/") || /[\p{Cc}]/u.test(localCache)) throw new Error("invalid Windows local application cache");
    const roaming = (await execFileText("wslpath", ["-u", windowsDirectories[1]!], options.signal)).trim();
    if (!roaming.startsWith("/") || /[\p{Cc}]/u.test(roaming)) throw new Error("invalid Windows application settings directory");
    const acquireStarter = await shouldAcquireStarterCharacter(join(roaming, "com.starcried.dsh-inochi2d-pet", "settings.json"));
    const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error("invalid StarLite plugin package version");
    }
    const prepared = await prepareEmbeddedCompanion({
      assetDirectory: fileURLToPath(new URL("../assets/windows-x64/", import.meta.url)),
      cacheDirectory: join(localCache, "StarCried", "StarLite", "companions"),
      expectedVersion: metadata.version,
      acquireStarter,
      ...(options.signal ? {signal: options.signal} : {}),
    });
    executable = prepared.executable;
    if (acquireStarter && !prepared.starterReady) options.onStarterFailure?.();
  }
  if (!executable.startsWith("/") || basename(executable).toLowerCase() !== "dsh-inochi2d-pet.exe") {
    throw new Error("StarLite for DSH executable is invalid");
  }
  options.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url], {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
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

/** Read only the selected-model policy; never transfer or log companion settings. */
export async function shouldAcquireStarterCharacter(path: string): Promise<boolean> {
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
        return "activeModelId" in value && typeof value.activeModelId === "string"
          && value.activeModelId.length > 0 && value.activeModelId.length <= 128
          && !/[\p{Cc}]/u.test(value.activeModelId);
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
      ...(signal ? {signal} : {}),
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
