import {beforeEach, describe, expect, it, vi} from "vitest";
import {apply} from "../src/index.js";
import {DshStartupError} from "../src/startup-error.js";

const {startDshAdapter} = vi.hoisted(() => ({startDshAdapter:vi.fn()}));
vi.mock("../src/adapter.js", () => ({startDshAdapter}));

describe("plugin startup diagnostics", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["unsupported-platform", /Windows 11 x64.*WSL2 x64/, /incompatible|status bridge/],
    ["incompatible-api", /required plugin API/, /unsupported|local status bridge/],
  ] as const)("disables safely with an actionable %s diagnostic", async (code, expected, excluded) => {
    startDshAdapter.mockRejectedValue(new DshStartupError(code));
    const warn = vi.fn();
    const dispose = await apply({on:vi.fn(),logger:{warn}});
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(expected));
    expect(warn.mock.calls[0]?.[0]).not.toMatch(excluded);
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("reports bridge startup failures without leaking Host error details", async () => {
    startDshAdapter.mockRejectedValue(Error("PRIVATE key/path/session details"));
    const warn = vi.fn();
    const dispose = await apply({on:vi.fn(),logger:{warn}});
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("local status bridge"));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|incompatible/);
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("keeps successful startup and shutdown behavior", async () => {
    const shutdown = vi.fn(async () => undefined), warn = vi.fn();
    startDshAdapter.mockResolvedValue(shutdown);
    const dispose = await apply({on:vi.fn(),logger:{warn}});
    expect(warn).not.toHaveBeenCalled();
    await dispose();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
