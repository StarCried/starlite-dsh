import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_WIRE_BYTES,
  parsePetSnapshot,
  parseBillingSnapshot,
  type PetSnapshot,
  type PetStateSource,
  MAX_INTERACTION_BYTES, isOpaqueRef, parsePetInteraction,
} from "@starcried/starlite-dsh-protocol";
import type { BillingSource } from "./billing.js";
import type {QuestionBridge} from "./questions.js";

const HEARTBEAT_MS = 15_000;
const MAX_CLIENTS = 2;
const MAX_LISTEN_ATTEMPTS = 16;
// Fetch implementations reject these ports before a request reaches the
// server. Port 0 can occasionally select one of them on hosts with a custom
// ephemeral-port range, which would make an otherwise healthy bridge unusable.
const BROWSER_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1_719, 1_720, 1_723, 2_049, 3_659, 4_045, 4_190, 5_060,
  5_061, 6_000, 6_566, 6_665, 6_666, 6_667, 6_668, 6_669, 6_697, 10_080,
]);
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

export async function startStatusServer(source: PetStateSource, options: {billing?: BillingSource; questions?: QuestionBridge} = {}): Promise<StatusServer> {
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
    if (!['GET','POST'].includes(request.method??'') || !authorized(request.headers.authorization, token)) {
      reject(response, 401);
      return;
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      reject(response, 403);
      return;
    }

    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/v1/health" && request.method === "GET") {
      response.writeHead(204, {
        "Cache-Control": "no-store",
        ...(origin ? corsHeaders(origin) : {}),
      });
      response.end();
      return;
    }
    if (path === "/v1/billing" && request.method === "GET" && options.billing) {
      void options.billing.read().then(snapshot => {
        const json = JSON.stringify(parseBillingSnapshot(snapshot));
        if (Buffer.byteLength(json, "utf8") > MAX_WIRE_BYTES) throw new Error("billing response too large");
        if (closed || response.destroyed) return;
        response.writeHead(200, {
          "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff", ...(origin ? corsHeaders(origin) : {}),
        });
        response.end(json);
      }).catch(() => {if (!response.destroyed && !response.headersSent) reject(response, 503);});
      return;
    }
    if(path === "/v1/interaction" && request.method === "GET" && options.questions){
      const query=new URL(request.url??"/","http://127.0.0.1").searchParams;
      const id=query.get("request");const pending=isOpaqueRef(id)&&query.getAll("request").length===1?options.questions.read(id):undefined;
      if(!pending){reject(response,409);return;}
      jsonResponse(response,parsePetInteraction(pending),origin);return;
    }
    if(options.questions && request.method === "POST" && ["/v1/interaction/answer","/v1/interaction/availability","/v1/session/open","/v1/web/open"].includes(path)){
      const bridge=options.questions;
      void readBody(request).then(async body=>{
        if(closed||response.destroyed)return;
        if(!body||typeof body!=="object"||Array.isArray(body))throw Error("invalid action");
        const row=body as Record<string,unknown>;
        if(path==="/v1/interaction/answer")await bridge.answer(row);
        else if(path==="/v1/interaction/availability"){
          if(typeof row.enabled!=="boolean"||Object.keys(row).some(k=>k!=="enabled"))throw Error("invalid availability");bridge.setEnabled(row.enabled);
        }else if(path==="/v1/web/open"){
          if(Object.keys(row).length!==0)throw Error("invalid navigation");await bridge.openWebUi();
        }else{
          if(!isOpaqueRef(row.sessionRef)||Object.keys(row).some(k=>k!=="sessionRef"))throw Error("invalid navigation");await bridge.open(row.sessionRef);
        }
        if(!response.destroyed){response.writeHead(204,{"Cache-Control":"no-store",...(origin?corsHeaders(origin):{})});response.end();}
      }).catch(()=>{if(!response.destroyed&&!response.headersSent)reject(response,409)});return;
    }
    if (path !== "/v1/events" || request.method !== "GET") {
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
    options.questions?.setConnected(true);
    response.write(": connected\n\n");
    if (latest) writeSnapshot(response, latest);
    request.on("close", () => {clients.delete(response);options.questions?.setConnected(clients.size>0)});
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
      options.billing?.close();
      options.questions?.close();
      await shutdown(server, clients, source, heartbeat);
    },
  };
}

function listenLoopback(server: Server): Promise<void> {
  return listenOnSafeLoopbackPort(server);
}

async function listenOnSafeLoopbackPort(server: Server): Promise<void> {
  for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt += 1) {
    await listenOnce(server);
    const address = server.address();
    if (address && typeof address !== "string" && isBrowserSafePort(address.port)) return;
    await closeServer(server);
  }
  throw new Error("DSH pet status server could not allocate a browser-safe port");
}

function listenOnce(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export function isBrowserSafePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535
    && !BROWSER_BLOCKED_PORTS.has(port);
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
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function jsonResponse(response:ServerResponse,value:unknown,origin:string|undefined):void{
  const json=JSON.stringify(value);if(Buffer.byteLength(json)>MAX_INTERACTION_BYTES){reject(response,413);return;}
  response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...(origin?corsHeaders(origin):{})});response.end(json);
}
async function readBody(request:IncomingMessage):Promise<unknown>{
  if(request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase()!=="application/json")throw Error("invalid action content type");
  if(Number(request.headers["content-length"])>MAX_INTERACTION_BYTES)throw Error("action too large");
  request.setTimeout(5000,()=>request.destroy());
  try{const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const data=Buffer.from(chunk);bytes+=data.length;if(bytes>MAX_INTERACTION_BYTES)throw Error("action too large");chunks.push(data)}return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown}
  finally{request.setTimeout(0)}
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}
