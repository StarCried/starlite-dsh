/** Exercise the installed official Connection Host and browser RPC implementations. */
import assert from "node:assert/strict";
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
const {Context} = await official("@deepseek-ai/cordis");
const connectionPackage = await official("@deepseek-ai/dsh-client-connection");
const {default: WebServer} = await official("@deepseek-ai/dsh-host-webserver");
const temporary = await mkdtemp(join(tmpdir(), "starlite-navigation-"));
const host = new Context(), client = new Context();
let navigator;
let connectionFiber;
let webServerFiber;
const settle = async () => {
  await Promise.all([...host.registry.values()].flatMap(runtime => [...runtime.fibers]).map(fiber => fiber.await()));
};
try {
  await build({entryPoints: [resolve("packages/dsh-plugin/src/navigation.ts")], outfile: join(temporary, "navigation.mjs"),
    bundle: true, platform: "node", format: "esm", external: ["open"], logLevel: "silent"});
  const {createDshNavigator} = await import(pathToFileURL(join(temporary, "navigation.mjs")).href);
  await qualifyWebClient();
  let credential;
  host.provide("credentials", {
    async modifyRecord(_key, transform) {credential = await transform(credential) ?? credential; return credential;},
  });
  host.provide("profileContext", {name: "desktop"});
  const opened = [];
  navigator = createDshNavigator(host, async url => {opened.push(url);});
  assert.equal(host.get("connection"), undefined);
  await assert.rejects(navigator.open({id: "not-ready"}), /unavailable/u);
  assert.deepEqual(opened, []);
  connectionFiber = await host.plugin(connectionPackage);
  await settle();
  assert.notEqual(host.get("connection"), undefined);
  await assert.rejects(navigator.open({id: "no-carrier"}), /unavailable/u);
  let base, cookie;
  const mountWebServer = async () => {
    // A root-provided fake server hides Cordis's shadow-context dependency
    // enforcement. Use the real carrier in its own sibling plugin fiber.
    webServerFiber = await host.plugin(WebServer, {host: "127.0.0.1", port: 0, compression: "none"});
    await settle();
    const server = host.get("webServer");
    server.registerFallback((request, response) => {
      // Same observable outcome as the official static frontend: an unclaimed
      // POST must be 405, making a silently missing RPC route fail this test.
      if (request.method !== "GET" && request.method !== "HEAD") {response.writeHead(405); response.end(); return;}
      if (host.get("connection").authorizeIndex(request, response)) response.end("fixture");
    });
    base = `http://127.0.0.1:${server.port}/`;
    const authenticated = await fetch(host.get("connection").authenticatedUrl(base), {redirect: "manual"});
    assert.equal(authenticated.status, 303);
    cookie = authenticated.headers.get("set-cookie").split(";", 1)[0];
    await authenticated.body?.cancel();
  };
  await mountWebServer();
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
  const url = () => new URL("starlite-navigation/listen", base);
  const envelope = {type: "client-request", rpcId: "fixture", method: "listen", payload: {clientRef}};
  const headers = {"content-type": "application/json"};
  assert.equal((await fetch(url(), {method: "POST", headers, body: JSON.stringify(envelope)})).status, 401);
  assert.equal((await fetch(url(), {method: "POST", headers: {...headers, cookie, origin: "https://evil.invalid"}, body: JSON.stringify(envelope)})).status, 403);
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
  // A client-side abort may settle before its HTTP disconnect reaches the Host.
  // Explicitly relinquish the old owner before testing a different renderer.
  await call("release", {clientRef}, new AbortController().signal);
  await navigator.open(undefined);
  assert.deepEqual(opened, ["dsh://open", "dsh://open"]);
  const interrupted = navigator.open({id: "withdrawn-session"});
  const rejected = assert.rejects(interrupted, /unavailable/u);
  const previous = await call("listen", {clientRef: crypto.randomUUID()}, new AbortController().signal);
  assert.equal(previous.ok, true);
  await connectionFiber.dispose(); await settle(); await rejected;
  assert.equal((await fetch(url(), {method: "POST", headers, body: JSON.stringify(envelope)})).status, 405);
  await assert.rejects(navigator.open({id: "not-ready"}), /unavailable/u);
  connectionFiber = await host.plugin(connectionPackage); await settle();
  const freshRef = crypto.randomUUID();
  assert.equal((await call("ack", {clientRef, requestRef: previous.value.requestRef, opened: true}, new AbortController().signal)).ok, false);
  const resumed = navigator.open({id: "replacement-session"});
  const replacement = await call("listen", {clientRef: freshRef}, new AbortController().signal);
  assert.equal(replacement.ok, true); assert.equal(replacement.value.sessionId, "replacement-session");
  assert.notEqual(replacement.value.requestRef, previous.value.requestRef);
  assert.equal((await call("ack", {clientRef: freshRef, requestRef: replacement.value.requestRef, opened: true}, new AbortController().signal)).ok, true);
  await resumed;
  await call("release", {clientRef: freshRef}, new AbortController().signal);
  const carrierWait = navigator.open({id: "withdrawn-carrier"});
  const carrierRejected = assert.rejects(carrierWait, /unavailable/u);
  const carrierRef = crypto.randomUUID();
  const beforeCarrier = await call("listen", {clientRef: carrierRef}, new AbortController().signal);
  assert.equal(beforeCarrier.ok, true);
  await webServerFiber.dispose(); await settle(); await carrierRejected;
  await assert.rejects(navigator.open({id: "no-carrier"}), /unavailable/u);
  await mountWebServer();
  assert.equal((await call("ack", {clientRef: carrierRef, requestRef: beforeCarrier.value.requestRef, opened: true}, new AbortController().signal)).ok, false);
  const carrierRestored = navigator.open({id: "replacement-carrier"});
  const restoredRef = crypto.randomUUID();
  const afterCarrier = await call("listen", {clientRef: restoredRef}, new AbortController().signal);
  assert.equal(afterCarrier.ok, true); assert.equal(afterCarrier.value.sessionId, "replacement-carrier");
  assert.notEqual(afterCarrier.value.requestRef, beforeCarrier.value.requestRef);
  assert.equal((await call("ack", {clientRef: restoredRef, requestRef: afterCarrier.value.requestRef, opened: true}, new AbortController().signal)).ok, true);
  await carrierRestored;
  await navigator.close();
  assert.equal((await fetch(url(), {method: "POST", headers: {...headers, cookie}, body: JSON.stringify(envelope)})).status, 405);
  const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
  console.log(`DSH ${version}: official sibling WebServer/Connection carrier binding, cold startup and both service replacements, missing-route 405 detection, official ClientSessions/Web target, Host/browser RPC, authentication, origin fence, opaque ACK, cancellation and disposal passed.`);
} finally {
  await navigator?.close();
  await client.fiber.dispose(); await host.fiber.dispose();
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(basename(temporary).startsWith("starlite-navigation-"));
  await rm(temporary, {recursive: true, force: true});
}

/** Exercise our mount with the official ClientSessions, not a permissive root stub. */
async function qualifyWebClient() {
  const context = new Context();
  const selected = [], replaced = [];
  const window = {location: {href: "http://127.0.0.1/#companionSession=fixture-target"}, history: {state: null,
    replaceState: (_state, _unused, url) => {replaced.push(url);}}, __ModuleLoader__: {load: () => undefined}};
  const sandbox = {window, URL, URLSearchParams, AbortController, AbortSignal, Headers, Response, Request,
    TextEncoder, TextDecoder, structuredClone, queueMicrotask, performance, crypto: globalThis.crypto, setTimeout, clearTimeout, console};
  const modules = new Map([
    ["@deepseek-ai/cordis", await official("@deepseek-ai/cordis")],
    // The published Host omits Zustand/Immer (frontend build dependencies).
    // Fixture only the public observable seam; ClientSessions and Cordis remain
    // the installed official implementations, including list/phase projection.
    ["@deepseek-ai/dsh-client-store", {
      notifySubscribers: listeners => {for (const listener of listeners) listener();},
      createSnapshotStore: initial => {
        let value = initial; const listeners = new Set();
        const notify = () => {for (const listener of listeners) listener();};
        return {getSnapshot: () => value, subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener);},
          set: next => {value = next; notify();}, update: mutate => {mutate(value); notify();}};
      },
    }],
  ]);
  const browserModule = async specifier => {
    let factory;
    window.__ModuleLoader__.load = row => {factory = row.factory;};
    runInNewContext(await readFile(requireOfficial.resolve(specifier), "utf8"), sandbox);
    const exported = factory(name => {
      const dependency = modules.get(name.replace(/\/client$/u, ""));
      if (!dependency) throw Error(`unexpected official ClientSessions external: ${name}`);
      return dependency;
    });
    modules.set(specifier.replace(/\/client$/u, ""), exported);
    return exported;
  };
  try {
    await browserModule("@deepseek-ai/dsh-api-gateway/client");
    const sessionsPlugin = await browserModule("@deepseek-ai/dsh-api-session-controller/client");
    const remote = {
      $on: () => () => undefined,
      $stream: () => ({restart: () => undefined, dispose: async () => undefined}),
      session: {list: async () => ({ok: true, value: {items: [
        {sessionId: "fixture-other", updatedAt: 1, agentAvailable: true, running: false, blank: false},
        {sessionId: "fixture-target", updatedAt: 2, agentAvailable: true, running: false, blank: true},
      ]}})}, commands: {}, subagents: {},
    };
    // Actual deployments provide Connection in its own plugin fiber. A root
    // provide() would let undeclared child reads succeed and hide regressions.
    await context.plugin(scope => scope.provide("connection", {generation: {getSnapshot: () => undefined, subscribe: () => () => undefined}}));
    await context.plugin(scope => {
      scope.provide("remote", remote);
      for (const name of ["session", "commands", "subagents"]) scope.provide(`remote.${name}`, remote[name]);
      scope.provide("fileUpload", {});
      scope.provide("typert", {contexts: {registerClient: () => () => undefined}});
    });
    await context.plugin(sessionsPlugin);
    const sessions = context.get("sessions");
    assert.equal(sessions.list.getSnapshot().phase, "pending");
    const built = await build({entryPoints: [resolve("packages/dsh-plugin/src/client.ts")], bundle: true,
      platform: "browser", format: "cjs", write: false, logLevel: "silent"});
    const companion = runInNewContext(`var module={exports:{}},exports=module.exports;\n${built.outputFiles[0].text}\nmodule.exports`, sandbox);
    const mounted = await context.plugin(companion);
    await sessions.refresh();
    assert.equal(sessions.list.getSnapshot().phase, "ready");
    assert(sessions.list.getSnapshot().ids.includes("fixture-target"));
    assert.deepEqual(selected, []);
    // Workspace appears later, exercising Cordis's actual dependency callback.
    await context.plugin(scope => scope.provide("uiWorkspace", {openSession: id => {selected.push(id);}}));
    for (const runtime of context.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
    assert.deepEqual(selected, ["fixture-target"]);
    assert.deepEqual(replaced, ["http://127.0.0.1/"]);
    await mounted.dispose();
  } finally {await context.fiber.dispose();}
}
