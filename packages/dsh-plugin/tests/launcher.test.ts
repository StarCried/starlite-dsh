import { describe, expect, it } from "vitest";
import {
  buildConnectionUrl,
  isWslEnvironment,
  parseRegisteredExecutable,
} from "../src/launcher.js";

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

  it("accepts only the exact Tauri protocol command shape", () => {
    expect(parseRegisteredExecutable(
      'HKEY_CURRENT_USER\\Software\\Classes\\dsh-inochi2d-pet\n    (Default)    REG_SZ    "E:\\Apps\\dsh-inochi2d-pet.exe" "%1"\n',
    )).toBe("E:\\Apps\\dsh-inochi2d-pet.exe");
    expect(() => parseRegisteredExecutable(
      '    (Default)    REG_SZ    cmd.exe /c calc.exe\n',
    )).toThrow(/registration/);
  });

  it("detects WSL from its stable environment markers", () => {
    expect(isWslEnvironment({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
    if (!process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME) {
      expect(isWslEnvironment({})).toBe(false);
    }
  });
});
