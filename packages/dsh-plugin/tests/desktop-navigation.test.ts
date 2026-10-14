import {afterEach, describe, expect, it, vi} from "vitest";
import {DesktopNavigationBroker} from "../src/desktop-navigation.js";
import {createDshNavigator} from "../src/navigation.js";
import {apply, followDesktopNavigation, type Sessions, type WorkspaceNavigation} from "../src/client.js";
import {startDshAdapter} from "../src/adapter.js";
import {NAVIGATION_CHANNEL, type NavigationCommand, type NavigationRpc, type RpcResult} from "../src/navigation-rpc.js";

const first = "123e4567-e89b-42d3-a456-426614174000";
const second = "123e4567-e89b-42d3-a456-426614174001";
const peer = {};
const signal = () => new AbortController();
async function command(result: Promise<RpcResult>): Promise<NavigationCommand> {
  const response = await result;
  expect(response.ok).toBe(true);
  return (response as {ok: true; value: NavigationCommand}).value;
}
function sessionsFixture(ids = ["target"]) {
  let list = {ids, phase: "ready"};
  const listeners = new Set<() => void>();
  const sessions: Sessions = {
    list: {getSnapshot: () => list, subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener);}},
    refresh: async () => undefined, refreshProjections: async () => undefined,
  };
  const workspace: WorkspaceNavigation = {openSession: vi.fn()};
  return {sessions, workspace, update: (ids: string[]) => {list = {ids, phase: "ready"}; for (const listener of listeners) listener();}};
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe("Desktop navigation ownership", () => {
  it("acknowledges exactly one renderer and refuses wrong, duplicated and stale acknowledgements", async () => {
    const broker = new DesktopNavigationBroker(), controller = signal();
    const request = broker.request("PRIVATE target");
    const delivery = await command(broker.handle("listen", {clientRef: first}, controller.signal, peer));
    expect(delivery.sessionId).toBe("PRIVATE target");
    const nextPoll = broker.handle("listen", {clientRef: first}, controller.signal, peer);
    const ack = {clientRef: first, requestRef: delivery.requestRef, opened: true};
    expect((await broker.handle("listen", {clientRef: second}, signal().signal, peer)).ok).toBe(false);
    expect((await broker.handle("ack", {...ack, clientRef: second}, signal().signal, peer)).ok).toBe(false);
    expect((await broker.handle("ack", ack, signal().signal, {})).ok).toBe(false);
    expect((await broker.handle("ack", {...ack, url: "https://evil.invalid"}, signal().signal, peer)).ok).toBe(false);
    expect((await broker.handle("ack", ack, signal().signal, peer)).ok).toBe(true);
    await expect(request.result).resolves.toBeUndefined();
    expect((await broker.handle("ack", ack, signal().signal, peer)).ok).toBe(false);
    controller.abort(); await nextPoll; broker.close();
  });

  it("redelivers an unexpired request after reload with a new acknowledgement identity", async () => {
    const broker = new DesktopNavigationBroker(), old = signal(), fresh = signal();
    const request = broker.request("target");
    const before = await command(broker.handle("listen", {clientRef: first}, old.signal, peer));
    const oldPoll = broker.handle("listen", {clientRef: first}, old.signal, peer);
    old.abort(); await oldPoll;
    const after = await command(broker.handle("listen", {clientRef: second}, fresh.signal, peer));
    expect(after.requestRef).not.toBe(before.requestRef);
    expect(after.sessionId).toBe(before.sessionId);
    expect((await broker.handle("ack", {clientRef: first, requestRef: before.requestRef, opened: true}, signal().signal, peer)).ok).toBe(false);
    await broker.handle("ack", {clientRef: second, requestRef: after.requestRef, opened: true}, fresh.signal, peer);
    await request.result; broker.close();
  });

  it("expires targets, rejects late acknowledgements, and clears all waits on disposal", async () => {
    vi.useFakeTimers();
    const broker = new DesktopNavigationBroker(), controller = signal();
    const request = broker.request("target");
    const delivery = await command(broker.handle("listen", {clientRef: first}, controller.signal, peer));
    const poll = broker.handle("listen", {clientRef: first}, controller.signal, peer);
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(request.result).rejects.toThrow("unavailable");
    expect((await broker.handle("ack", {clientRef: first, requestRef: delivery.requestRef, opened: true}, controller.signal, peer)).ok).toBe(false);
    controller.abort(); await poll;
    const pending = broker.request("next");
    const emptyPoll = broker.handle("listen", {clientRef: second}, signal().signal, peer);
    broker.close(); broker.close();
    await expect(pending.result).rejects.toThrow("unavailable");
    await emptyPoll;
    expect((await broker.handle("listen", {clientRef: first}, signal().signal, peer)).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a new target supersedes old acknowledgements and idle polls are bounded", async () => {
    vi.useFakeTimers();
    const broker = new DesktopNavigationBroker(), controller = signal();
    const old = broker.request("old");
    const oldCommand = await command(broker.handle("listen", {clientRef: first}, controller.signal, peer));
    const poll = broker.handle("listen", {clientRef: first}, controller.signal, peer);
    const current = broker.request("new");
    await expect(old.result).rejects.toThrow();
    const newCommand = await command(poll);
    expect(newCommand.sessionId).toBe("new");
    expect((await broker.handle("ack", {clientRef: first, requestRef: oldCommand.requestRef, opened: true}, controller.signal, peer)).ok).toBe(false);
    await broker.handle("ack", {clientRef: first, requestRef: newCommand.requestRef, opened: true}, controller.signal, peer);
    await current.result;
    const idle = broker.handle("listen", {clientRef: first}, controller.signal, peer);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await idle).toEqual({ok: true, value: null});
    broker.close();
  });
});

describe("Desktop client target delivery", () => {
  it("recovers when a reloaded renderer arrives before the old poll disconnects", async () => {
    vi.useFakeTimers();
    const broker = new DesktopNavigationBroker(), fixture = sessionsFixture([]);
    const busy = vi.fn();
    const rpc: NavigationRpc = {call: async (_channel, endpoint, payload, abort = signal().signal) => {
      const result = await broker.handle(endpoint, payload, abort, peer);
      if (!result.ok && result.error.code === "starlite/navigation-busy") busy();
      return result;
    }};
    const stopOld = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, first);
    const pending = broker.request("target");
    await vi.advanceTimersByTimeAsync(0);
    const stopNew = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, second);
    await vi.advanceTimersByTimeAsync(500);
    expect(busy).toHaveBeenCalled();
    stopOld();
    await vi.advanceTimersByTimeAsync(500);
    fixture.update(["target"]);
    await vi.advanceTimersByTimeAsync(0);
    await pending.result;
    expect(fixture.workspace.openSession).toHaveBeenCalledExactlyOnceWith("target");
    stopNew(); broker.close();
  });

  it.each(["busy", "unavailable", "transport"])("bounds retries and never treats %s as navigation success", async reason => {
    vi.useFakeTimers();
    const fixture = sessionsFixture();
    const call = vi.fn(async (_channel: string, _endpoint: string, _payload: unknown): Promise<RpcResult> => {
      if (reason === "transport") throw Error("fixture transport failure");
      return {ok: false, error: {code: `starlite/navigation-${reason}`, message: "fixture", details: {}}};
    });
    const stop = followDesktopNavigation({call}, fixture.sessions, fixture.workspace, first);
    await vi.advanceTimersByTimeAsync(20_001);
    const count = call.mock.calls.length;
    expect(count).toBe(reason === "busy" ? 81 : 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call).toHaveBeenCalledTimes(count);
    expect(fixture.workspace.openSession).not.toHaveBeenCalled(); stop();
  });

  it("re-registers after an official connection generation reset and removes that listener", async () => {
    const fixture = sessionsFixture();
    vi.stubGlobal("window", {location: {href: "dsh-app://app/"}, history: {}, dshDesktop: {protocolVersion: 1}});
    let restart: (() => void) | undefined;
    const remove = vi.fn();
    const call = vi.fn(async (_channel: string, _endpoint: string, _payload: unknown): Promise<RpcResult> =>
      ({ok: false, error: {code: "starlite/navigation-unavailable", message: "fixture", details: {}}}));
    const scope = {sessions: fixture.sessions, uiWorkspace: fixture.workspace, connection: {rpc: {call}},
      on: (_event: "connection/reset", callback: () => void) => {restart = callback; return remove;}};
    const stop = apply({...scope, inject: (_dependencies, callback) => callback(scope)});
    await Promise.resolve();
    expect(call.mock.calls.filter(row => row[1] === "listen")).toHaveLength(1);
    restart!();
    await Promise.resolve();
    expect(call.mock.calls.filter(row => row[1] === "listen")).toHaveLength(2);
    stop(); restart!();
    expect(remove).toHaveBeenCalledOnce();
    expect(call.mock.calls.filter(row => row[1] === "listen")).toHaveLength(2);
  });

  it("waits for the shared services only on the owned Desktop origin and stops late client startup", async () => {
    const fixture = sessionsFixture();
    let mount: ((context: {sessions: Sessions; uiWorkspace: WorkspaceNavigation; connection: {rpc: NavigationRpc}}) => void) | undefined;
    const inject = vi.fn((_names: string[], callback: NonNullable<typeof mount>) => {mount = callback;});
    vi.stubGlobal("window", {location: {href: "dsh-app://app/"}, history: {}, dshDesktop: {protocolVersion: 1}});
    const call = vi.fn(async () => ({ok: false as const, error: {code: "fixture", message: "fixture", details: {}}}));
    const stop = apply({sessions: fixture.sessions, inject});
    expect(inject).toHaveBeenCalledExactlyOnceWith(["connection", "uiWorkspace"], expect.any(Function));
    expect(call).not.toHaveBeenCalled();
    stop();
    mount!({sessions: fixture.sessions, uiWorkspace: fixture.workspace, connection: {rpc: {call}}});
    expect(call).not.toHaveBeenCalled();
  });

  it("selects the exact session and keeps ownership until acknowledged", async () => {
    const broker = new DesktopNavigationBroker(), fixture = sessionsFixture();
    const rpc: NavigationRpc = {call: async (channel, endpoint, payload, abort = signal().signal) => {
      expect(channel).toBe(NAVIGATION_CHANNEL); return broker.handle(endpoint, payload, abort, peer);
    }};
    const stop = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, first);
    await broker.request("target").result;
    expect(fixture.workspace.openSession).toHaveBeenCalledExactlyOnceWith("target");
    stop(); broker.close();
  });

  it("a renderer reload cancels pending discovery and never selects a later stale target", async () => {
    const broker = new DesktopNavigationBroker(), fixture = sessionsFixture([]);
    const rpc: NavigationRpc = {call: (_channel, endpoint, payload, abort = signal().signal) => broker.handle(endpoint, payload, abort, peer)};
    const stopOld = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, first);
    const request = broker.request("target");
    await Promise.resolve(); await Promise.resolve();
    stopOld();
    const stopNew = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, second);
    await Promise.resolve(); await Promise.resolve();
    fixture.update(["target"]);
    await request.result;
    expect(fixture.workspace.openSession).toHaveBeenCalledExactlyOnceWith("target");
    stopNew(); broker.close();
  });

  it("cancels superseded discovery and expired requests before changing selection", async () => {
    vi.useFakeTimers();
    const broker = new DesktopNavigationBroker(), fixture = sessionsFixture([]);
    const rpc: NavigationRpc = {call: (_channel, endpoint, payload, abort = signal().signal) => broker.handle(endpoint, payload, abort, peer)};
    const stop = followDesktopNavigation(rpc, fixture.sessions, fixture.workspace, first);
    const old = broker.request("old");
    await Promise.resolve(); await Promise.resolve();
    const current = broker.request("current");
    await vi.advanceTimersByTimeAsync(0);
    fixture.update(["old"]);
    expect(fixture.workspace.openSession).not.toHaveBeenCalled();
    await expect(old.result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8_001);
    fixture.update(["current"]);
    expect(fixture.workspace.openSession).not.toHaveBeenCalled();
    await expect(current.result).rejects.toThrow();
    stop(); broker.close();
  });
});

describe("Host surface selection", () => {
  it("waits for Connection during cold startup and revokes requests on dependency replacement", async () => {
    let mount: ((scope: {get(name: string): unknown}) => (() => Promise<void>) | undefined) | undefined;
    let unmount: (() => Promise<void>) | undefined;
    const dispose = vi.fn(async () => {await unmount?.();});
    const open = vi.fn(async () => undefined), remove = vi.fn(async () => undefined);
    let handler: ((endpoint: string, payload: unknown, abort: AbortSignal, peer: unknown) => Promise<RpcResult>) | undefined;
    const handle = vi.fn((_channel: string, callback: NonNullable<typeof handler>) => {handler = callback; return remove;});
    const navigator = createDshNavigator({
      get: name => name === "profileContext" ? {name: "desktop"} : undefined,
      inject: (dependencies, callback) => {expect(dependencies).toEqual(["connection"]); mount = callback; return {dispose};},
    }, open);
    expect(handle).not.toHaveBeenCalled();
    await expect(navigator.open({id: "target"})).rejects.toThrow("unavailable");
    expect(open).not.toHaveBeenCalled();
    const scope = {get: () => ({rpc: {handle}})};
    unmount = mount!(scope);
    const firstHandler = handler!;
    const pending = navigator.open({id: "target"});
    const rejected = expect(pending).rejects.toThrow("unavailable");
    const delivered = await command(firstHandler("listen", {clientRef: first}, signal().signal, peer));
    await unmount!(); await rejected;
    expect((await firstHandler("ack", {clientRef: first, requestRef: delivered.requestRef, opened: true}, signal().signal, peer)).ok).toBe(false);
    unmount = mount!(scope);
    expect(handle).toHaveBeenCalledTimes(2);
    const fresh = navigator.open({id: "fresh"});
    const delivery = await command(handler!("listen", {clientRef: second}, signal().signal, peer));
    await handler!("ack", {clientRef: second, requestRef: delivery.requestRef, opened: true}, signal().signal, peer);
    await fresh; await navigator.close(); await navigator.close();
    expect(remove).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledOnce();
    mount!(scope);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("does not disable DSH for an unavailable optional Desktop contract or attach after disposal", async () => {
    let mount: ((scope: {get(name: string): unknown}) => (() => Promise<void>) | undefined) | undefined;
    const dispose = vi.fn(async () => undefined), handle = vi.fn();
    const navigator = createDshNavigator({get: () => ({name: "desktop"}), inject: (_deps, callback) => {mount = callback; return {dispose};}});
    expect(() => mount!({get: () => ({rpc: {}})})).not.toThrow();
    await expect(navigator.open({id: "target"})).rejects.toThrow("unavailable");
    await navigator.close();
    mount!({get: () => ({rpc: {handle}})});
    expect(handle).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "dispose"])("bounds the entire show-and-ACK operation, including a hung opener: %s", async outcome => {
    vi.useFakeTimers();
    let handler: ((endpoint: string, payload: unknown, abort: AbortSignal, peer: unknown) => Promise<RpcResult>) | undefined;
    let openingSignal: AbortSignal | undefined;
    const navigator = createDshNavigator({get: name => name === "profileContext" ? {name: "desktop"} : {rpc: {handle: (_channel: string, fn: NonNullable<typeof handler>) => {handler = fn; return () => undefined;}}}},
      (_url, abort) => {openingSignal = abort; return new Promise<void>(() => undefined);});
    const pending = navigator.open({id: "target"});
    const rejected = expect(pending).rejects.toThrow("unavailable");
    const delivered = await command(handler!("listen", {clientRef: first}, signal().signal, peer));
    // Even an early navigation ACK cannot give the OS opener an unbounded wait.
    await handler!("ack", {clientRef: first, requestRef: delivered.requestRef, opened: true}, signal().signal, peer);
    if (outcome === "dispose") await navigator.close();
    else await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(openingSignal?.aborted).toBe(true); await navigator.close();
  });

  it("registers through the adapter and removes its public RPC route on startup failure and disposal", async () => {
    const remove = vi.fn(async () => undefined), handle = vi.fn(() => remove);
    const context = {get: (name: string) => name === "profileContext" ? {name: "desktop"} : name === "connection" ? {rpc: {handle}} : undefined,
      on: () => () => undefined};
    const dependencies = {host: () => "windows" as const, launch: async () => undefined};
    await expect(startDshAdapter(context, {...dependencies, startServer: async () => {throw Error("fixture startup failed");}})).rejects.toThrow("fixture startup failed");
    expect(remove).toHaveBeenCalledOnce();
    const stop = await startDshAdapter(context, {...dependencies, startServer: async () => ({port: 41234, token: "a".repeat(43), close: async () => undefined})});
    await stop(); await stop();
    expect(handle).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2);
  });

  it("queues Desktop session navigation, shows an absent-session window, and never opens a browser on reload timeout", async () => {
    vi.useFakeTimers();
    let handler: ((endpoint: string, payload: unknown, abort: AbortSignal, peer: unknown) => Promise<RpcResult>) | undefined;
    const remove = vi.fn(), open = vi.fn(async (_url: string) => undefined);
    const navigator = createDshNavigator({get: name => name === "profileContext" ? {name: "desktop"} : {rpc: {handle: (_channel: string, fn: NonNullable<typeof handler>) => {handler = fn; return remove;}}}}, open);
    await navigator.open(undefined);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("dsh://open", expect.any(AbortSignal));
    const target = navigator.open({id: "target"});
    const delivery = await command(handler!("listen", {clientRef: first}, signal().signal, peer));
    await handler!("ack", {clientRef: first, requestRef: delivery.requestRef, opened: true}, signal().signal, peer);
    await target;
    const loading = navigator.open({id: "target"});
    const caught = expect(loading).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(8_001); await caught;
    expect(open.mock.calls.every(call => call[0] === "dsh://open")).toBe(true);
    await navigator.close(); await navigator.close();
    expect(remove).toHaveBeenCalledOnce();
    await expect(navigator.open(undefined)).rejects.toThrow();
  });

  it.each([undefined, {name: "web"}, {name: "custom"}])("keeps ordinary and Electron-bundled CLI profiles on Web navigation: %j", async profile => {
    const open = vi.fn(async (_url: string) => undefined), handle = vi.fn();
    const navigator = createDshNavigator({get: name => name === "profileContext" ? profile : name === "webServer" ? {host: "127.0.0.1", port: 4194} : {rpc: {handle}, authenticatedUrl: (url: string) => url}}, open);
    await navigator.open({id: "target"});
    expect(new URL(open.mock.calls[0]![0]!).hash).toBe("#companionSession=target");
    expect(handle).not.toHaveBeenCalled(); await navigator.close();
  });

  it("fails closed on missing Desktop contracts or invalid target identities", async () => {
    const open = vi.fn(async () => undefined);
    expect(() => createDshNavigator({get: name => name === "profileContext" ? {name: "desktop"} : {}}, open)).toThrow("contract unavailable");
    const navigator = createDshNavigator({get: name => name === "profileContext" ? {name: "desktop"} : {rpc: {handle: () => () => undefined}}}, open);
    for (const key of [null, {}, {id: "bad\nidentity"}]) await expect(navigator.open(key)).rejects.toThrow("session unavailable");
    expect(open).not.toHaveBeenCalled(); await navigator.close();
  });
});
