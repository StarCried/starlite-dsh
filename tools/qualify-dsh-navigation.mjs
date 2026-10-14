/** Exercise the installed official Connection Host and browser RPC implementations. */
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runInNewContext} from "node:vm";
import {build} from "esbuild";

if (!process.argv[2]) throw Error("Usage: node tools/qualify-dsh-navigation.mjs <DSH package directory>");
const packageRoot = resolve(process.argv[2]);
const requireOfficial = createRequire(join(packageRoot, "package.json"));
const official = async name => import(pathToFileURL(requireOfficial.resolve(name)).href);
const {Context, Service} = await official("@deepseek-ai/cordis");
const connectionPackage = await official("@deepseek-ai/dsh-client-connection");
const temporary = await mkdtemp(join(tmpdir(), "starlite-navigation-"));
const host = new Context(), client = new Context();
const routes = new Map();
let navigator;
const sockets = new Set();
const server = createServer((request, response) => {
  if (new URL(request.url, "http://fixture.invalid").pathname === "/") {
    if (host.get("connection").authorizeIndex(request, response)) {response.end("fixture");}
    return;
  }
  const route = [...routes.values()].find(row => request.url.startsWith(row.path + "/"));
  if (route) void route.handler(request, response).catch(() => {response.writeHead(500); response.end();});
  else {response.writeHead(404); response.end();}
});
server.on("connection", socket => {sockets.add(socket); socket.once("close", () => sockets.delete(socket));});
try {
  await build({entryPoints: [resolve("packages/dsh-plugin/src/navigation.ts")], outfile: join(temporary, "navigation.mjs"),
    bundle: true, platform: "node", format: "esm", external: ["open"], logLevel: "silent"});
  const {createDshNavigator} = await import(pathToFileURL(join(temporary, "navigation.mjs")).href);
  class FixtureWebServer extends Service {
    host = "127.0.0.1";
    protocol = "http:";
    constructor(context) {super(context, "webServer");}
    register(route) {
      return this.ctx.effect(() => {
        assert(!routes.has(route.path)); routes.set(route.path, route);
        return () => {routes.delete(route.path);};
      });
    }
  }
  new FixtureWebServer(host);
  let credential;
  host.provide("credentials", {
    async modifyRecord(_key, transform) {credential = await transform(credential) ?? credential; return credential;},
  });
  await connectionPackage.apply(host);
  host.provide("profileContext", {name: "desktop"});
  const opened = [];
  navigator = createDshNavigator(host, async url => {opened.push(url);});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const authenticated = await fetch(host.get("connection").authenticatedUrl(base), {redirect: "manual"});
  assert.equal(authenticated.status, 303);
  const cookie = authenticated.headers.get("set-cookie").split(";", 1)[0];
  let factory;
  runInNewContext(await readFile(requireOfficial.resolve("@deepseek-ai/dsh-client-connection/client"), "utf8"), {
    window: {__ModuleLoader__: {load(row) {factory = row.factory;}}},
    crypto: globalThis.crypto, AbortController, Headers, Response, Request, URL,
    setTimeout, clearTimeout, console,
  });
  const {installConnection} = factory(name => {throw Error(`unexpected official browser external: ${name}`);});
  installConnection(client, {transport: {ownsHost: true, fetch: (input, init) => {
    const headers = new Headers(init.headers); headers.set("cookie", cookie);
    return fetch(new URL(input, base), {...init, headers});
  }}});
  const browser = client.get("connection");
  const clientRef = crypto.randomUUID();
  const active = new AbortController();
  const call = (endpoint, payload, abort = active.signal) => browser.rpc.call("/starlite-navigation", endpoint, payload, abort);
  const url = new URL("starlite-navigation/listen", base);
  const envelope = {type: "client-request", rpcId: "fixture", method: "listen", payload: {clientRef}};
  const headers = {"content-type": "application/json"};
  assert.equal((await fetch(url, {method: "POST", headers, body: JSON.stringify(envelope)})).status, 401);
  assert.equal((await fetch(url, {method: "POST", headers: {...headers, cookie, origin: "https://evil.invalid"}, body: JSON.stringify(envelope)})).status, 403);
  const pending = navigator.open({id: "fixture-session"});
  void pending.catch(() => undefined);
  const delivered = await call("listen", {clientRef});
  assert.equal(delivered.ok, true); assert.equal(delivered.value.sessionId, "fixture-session");
  const next = call("listen", {clientRef});
  void next.catch(() => undefined);
  const ack = {clientRef, requestRef: delivered.value.requestRef, opened: true};
  assert.equal((await call("ack", {...ack, clientRef: crypto.randomUUID()})).ok, false);
  assert.equal((await call("ack", ack)).ok, true);
  await pending;
  assert.equal((await call("ack", ack)).ok, false);
  active.abort(); await assert.rejects(next);
  await navigator.open(undefined);
  assert.deepEqual(opened, ["dsh://open", "dsh://open"]);
  await navigator.close();
  assert.equal((await fetch(url, {method: "POST", headers: {...headers, cookie}, body: JSON.stringify(envelope)})).status, 404);
  const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
  console.log(`DSH ${version}: official Host/browser RPC, cookie authentication, origin fence, opaque ACK, cancellation and disposal passed.`);
} finally {
  await navigator?.close();
  await client.fiber.dispose(); await host.fiber.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(basename(temporary).startsWith("starlite-navigation-"));
  await rm(temporary, {recursive: true, force: true});
}
