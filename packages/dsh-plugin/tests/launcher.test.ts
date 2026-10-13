import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConnectionUrl,
  isWslEnvironment,
  launchWindowsPet,
  validateExecutableOverride,
} from "../src/launcher.js";

const {execFileMock, spawnMock} = vi.hoisted(() => ({execFileMock: vi.fn(), spawnMock: vi.fn()}));
vi.mock("node:child_process", () => ({execFile: execFileMock, spawn: spawnMock}));
afterEach(() => {vi.unstubAllEnvs(); vi.clearAllMocks();});

describe("Windows launcher contract", () => {
  it("builds a narrowly scoped protocol URL", () => {
    const token = "a".repeat(43);
    const url = new URL(buildConnectionUrl({
      port: 43123,
      token,
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
    }));
    expect(url.protocol).toBe("dsh-inochi2d-pet:");
    expect(url.hostname).toBe("connect");
    expect(url.searchParams.get("port")).toBe("43123");
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("instance")).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("rejects malformed ports and tokens", () => {
    expect(() => buildConnectionUrl({ port: 0, token: "a".repeat(43) })).toThrow(/port/);
    expect(() => buildConnectionUrl({ port: 1234, token: "short" })).toThrow(/token/);
    expect(() => buildConnectionUrl({
      port: 1234,
      token: "a".repeat(43),
      instanceId: "not-a-uuid",
    })).toThrow(/instance/);
  });

  it("detects WSL from its stable environment markers", () => {
    expect(isWslEnvironment({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
    if (!process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME) {
      expect(isWslEnvironment({})).toBe(false);
    }
  });

  it("accepts an explicit local developer build", () => {
    const path = "E:\\Local builds\\dsh-inochi2d-pet.exe";
    expect(validateExecutableOverride(path)).toBe(path);
  });

  it("rejects command strings, remote builds and path traversal", () => {
    for (const path of [
      "", "dsh-inochi2d-pet.exe", "/mnt/e/dsh-inochi2d-pet.exe",
      "\\\\server\\share\\dsh-inochi2d-pet.exe", "E:\\Apps\\other.exe",
      '"E:\\Apps\\dsh-inochi2d-pet.exe"', "E:\\Apps\\dsh-inochi2d-pet.exe --flag",
      "E:\\Apps\n\\dsh-inochi2d-pet.exe",
      "E:\\Apps\\..\\dsh-inochi2d-pet.exe",
    ]) expect(() => validateExecutableOverride(path)).toThrow(/DSH_INOCHI2D_PET_EXE/);
  });

  it("starts the explicit developer executable directly without a command shell or registry", async () => {
    vi.stubEnv("DSH_INOCHI2D_PET_EXE", "E:\\Apps\\dsh-inochi2d-pet.exe");
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => callback(null, "/mnt/e/Apps/dsh-inochi2d-pet.exe"));
    const child = Object.assign(new EventEmitter(), {unref: vi.fn()}); spawnMock.mockReturnValueOnce(child);
    const started = launchWindowsPet({port: 43123, token: "a".repeat(43)});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("spawn"); await started;
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith("wslpath", ["-u", "E:\\Apps\\dsh-inochi2d-pet.exe"], expect.objectContaining({windowsHide: true}), expect.any(Function));
    expect(spawnMock).toHaveBeenCalledWith("/mnt/e/Apps/dsh-inochi2d-pet.exe", [expect.stringContaining("dsh-inochi2d-pet://connect")], {detached: false, shell: false, stdio: "ignore", windowsHide: true});
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("does not spawn a delayed executable after its DSH owner has closed", async () => {
    vi.stubEnv("DSH_INOCHI2D_PET_EXE", "E:\\Apps\\dsh-inochi2d-pet.exe");
    let complete: ((error: Error | null, result: string) => void) | undefined;
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {complete = callback;});
    const controller = new AbortController();
    const started = launchWindowsPet({port: 43123, token: "a".repeat(43)}, {signal: controller.signal});
    controller.abort(); complete!(null, "/mnt/e/Apps/dsh-inochi2d-pet.exe");
    await expect(started).rejects.toThrow(); expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses only a static PowerShell cache query in unified mode and never falls back to registration", async () => {
    vi.stubEnv("DSH_INOCHI2D_PET_EXE", undefined);
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error("interop unavailable"), ""));
    await expect(launchWindowsPet({port: 43123, token: "a".repeat(43)})).rejects.toThrow();
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('LocalApplicationData'); [Environment]::GetFolderPath('ApplicationData')"], expect.objectContaining({windowsHide: true}), expect.any(Function));
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
