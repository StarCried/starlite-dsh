import { describe, expect, it } from "vitest";
import { PET_PROTOCOL_VERSION, type PetStateSource } from "@dsh-inochi2d-pet/protocol";
import { isBrowserSafePort, startStatusServer } from "../src/server.js";

function idleSource(): PetStateSource {
  return {
    async start(emit) {
      emit({
        protocolVersion: PET_PROTOCOL_VERSION,
        sequence: 0,
        emittedAt: Date.now(),
        state: "idle",
        ...({ userMessage: "TOP SECRET" } as object),
      });
    },
    async stop() {},
  };
}

describe("status SSE server", () => {
  it("rejects ports blocked by browser fetch implementations", () => {
    expect(isBrowserSafePort(0)).toBe(false);
    expect(isBrowserSafePort(6000)).toBe(false);
    expect(isBrowserSafePort(6667)).toBe(false);
    expect(isBrowserSafePort(10_080)).toBe(false);
    expect(isBrowserSafePort(8084)).toBe(true);
    expect(isBrowserSafePort(65_535)).toBe(true);
  });

  it("binds loopback, requires bearer auth, and sends the initial snapshot", async () => {
    const server = await startStatusServer(idleSource());
    expect(isBrowserSafePort(server.port)).toBe(true);
    const endpoint = `http://127.0.0.1:${server.port}/v1/events`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);

      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("event: snapshot");
      expect(text).toContain('"state":"idle"');
      expect(text).not.toContain("TOP SECRET");
      expect(text).not.toContain("userMessage");
      await reader!.cancel();
    } finally {
      await server.close();
    }
  });

  it("allows only the Tauri origin for credentialed CORS", async () => {
    const server = await startStatusServer(idleSource());
    const endpoint = `http://127.0.0.1:${server.port}/v1/events`;
    try {
      const denied = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "https://attacker.invalid" },
      });
      expect(denied.status).toBe(403);

      const allowed = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "http://tauri.localhost" },
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");

      const development = await fetch(endpoint, {
        method: "OPTIONS",
        headers: { Origin: "http://127.0.0.1:1420" },
      });
      expect(development.status).toBe(204);
    } finally {
      await server.close();
    }
  });
});
