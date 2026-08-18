import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_WIRE_BYTES,
  parsePetSnapshot,
  type PetSnapshot,
  type PetStateSource,
} from "@dsh-inochi2d-pet/protocol";

const HEARTBEAT_MS = 15_000;
const MAX_CLIENTS = 2;
const ALLOWED_ORIGINS = new Set([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
]);

export interface StatusServer {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

export async function startStatusServer(source: PetStateSource): Promise<StatusServer> {
  const token = randomBytes(32).toString("base64url");
  const clients = new Set<ServerResponse>();
  let latest: PetSnapshot | undefined;
  let closed = false;

  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        reject(response, 403);
        return;
      }
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }
    if (request.method !== "GET" || !authorized(request.headers.authorization, token)) {
      reject(response, 401);
      return;
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      reject(response, 403);
      return;
    }

    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/v1/health") {
      response.writeHead(204, {
        "Cache-Control": "no-store",
        ...(origin ? corsHeaders(origin) : {}),
      });
      response.end();
      return;
    }
    if (path !== "/v1/events") {
      reject(response, 404);
      return;
    }
    if (clients.size >= MAX_CLIENTS) {
      reject(response, 429);
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      ...(origin ? corsHeaders(origin) : {}),
    });
    response.flushHeaders();
    clients.add(response);
    response.write(": connected\n\n");
    if (latest) writeSnapshot(response, latest);
    request.on("close", () => clients.delete(response));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    await source.start((snapshot) => {
      let canonical: PetSnapshot;
      try {
        // Reconstruct the allow-listed protocol object before serialization.
        // This prevents an accidental structural subtype from carrying a DSH
        // event, path, or other extra field onto the wire.
        canonical = parsePetSnapshot(snapshot);
      } catch {
        return;
      }
      latest = canonical;
      for (const client of clients) writeSnapshot(client, canonical);
    });
    await listenLoopback(server);
  } catch (error) {
    clearInterval(heartbeat);
    await source.stop().catch(() => undefined);
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await shutdown(server, clients, source, heartbeat);
    throw new Error("DSH pet status server did not receive a TCP port");
  }

  return {
    port: address.port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await shutdown(server, clients, source, heartbeat);
    },
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function shutdown(
  server: Server,
  clients: Set<ServerResponse>,
  source: PetStateSource,
  heartbeat: ReturnType<typeof setInterval>,
): Promise<void> {
  clearInterval(heartbeat);
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.allSettled([source.stop(), closeServer(server)]);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function writeSnapshot(response: ServerResponse, snapshot: PetSnapshot): void {
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, "utf8") > MAX_WIRE_BYTES) return;
  response.write(`id: ${snapshot.sequence}\nevent: snapshot\ndata: ${json}\n\n`);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}
