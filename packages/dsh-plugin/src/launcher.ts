import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { basename } from "node:path";
import { execFile, spawn } from "node:child_process";

const PROTOCOL_COMMAND_KEY =
  "HKCU\\Software\\Classes\\dsh-inochi2d-pet\\shell\\open\\command";

export interface PetConnection {
  readonly port: number;
  readonly token: string;
  readonly instanceId?: string;
}

export function isWslEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.WSL_INTEROP || environment.WSL_DISTRO_NAME)
    || release().toLowerCase().includes("microsoft");
}

/** Starts the registered Windows protocol handler without waiting for the UI. */
export async function launchWindowsPet(connection: PetConnection): Promise<void> {
  const url = buildConnectionUrl(connection);
  const windowsExecutable = parseRegisteredExecutable(
    await execFileText("reg.exe", ["query", PROTOCOL_COMMAND_KEY, "/ve"]),
  );
  const executable = (await execFileText("wslpath", ["-u", windowsExecutable])).trim();
  if (!executable.startsWith("/") || basename(executable).toLowerCase() !== "dsh-inochi2d-pet.exe") {
    throw new Error("registered DSH Companion executable is invalid");
  }

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

/** Accepts only the exact command shape written by the Tauri installer. */
export function parseRegisteredExecutable(output: string): string {
  const value = output.match(/\bREG_SZ\s+(.+)$/imu)?.[1]?.trim();
  const executable = value?.match(/^"([^"]+)"\s+"%1"$/u)?.[1];
  if (!executable || !executable.toLowerCase().endsWith("\\dsh-inochi2d-pet.exe")) {
    throw new Error("DSH Companion protocol registration is missing or invalid");
  }
  return executable;
}

function execFileText(file: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, arguments_, {
      encoding: "utf8",
      maxBuffer: 8_192,
      timeout: 3_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
