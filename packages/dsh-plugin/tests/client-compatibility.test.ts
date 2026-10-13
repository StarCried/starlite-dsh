import {afterEach, describe, expect, it, vi} from "vitest";
import {apply, followCompanionSession, inject, type Sessions, type WorkspaceNavigation} from "../src/client.js";

type List = ReturnType<Sessions["list"]["getSnapshot"]>;
const history = () => ({state: {keep: true}, replaceState: vi.fn()});
const location = (id = "target") => ({href: `http://127.0.0.1/#keep=1&companionSession=${id}`});
function projected(initial: List) {
  let snapshot = initial;
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const sessions: Sessions = {
    list: {getSnapshot: () => snapshot, subscribe: vi.fn(listener => {changed = listener; return unsubscribe;})},
    refresh: vi.fn(async () => undefined),
    refreshProjections: vi.fn(async () => undefined),
  };
  const workspace: WorkspaceNavigation = {openSession: vi.fn()};
  return {sessions, workspace, unsubscribe, update: (next: List) => {snapshot = next; changed();}};
}
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe("DSH client navigation compatibility", () => {
  it("opens an exact 0.2 listed session through the workspace owner", () => {
    const {sessions, workspace, unsubscribe, update} = projected({ids: ["target"], phase: "ready"});
    const pageHistory = history();
    const stop = followCompanionSession(sessions, location(), pageHistory, workspace);
    update({ids: ["target"], phase: "ready"});
    expect(workspace.openSession).toHaveBeenCalledExactlyOnceWith("target");
    expect(pageHistory.replaceState).toHaveBeenCalledExactlyOnceWith(pageHistory.state, "", "http://127.0.0.1/#keep=1");
    expect(unsubscribe).toHaveBeenCalled();
    stop();
  });

  it.each(["one-shot", "continuable"])("opens an authoritative 0.2 %s child without legacy kind fields", mode => {
    const {sessions, workspace} = projected({ids: ["root"], phase: "ready", projectionsBySession: {
      root: {state: "ready", values: {subagentCatalog: [{id: "target", mode}]}},
    }});
    const stop = followCompanionSession(sessions, location(), history(), workspace);
    expect(workspace.openSession).toHaveBeenCalledExactlyOnceWith({parentSessionId: "root", childSessionId: "target", mode});
    stop();
  });

  it("waits for a ready authoritative projection before selecting a child", async () => {
    const pending = deferred();
    const {sessions, workspace, update} = projected({ids: ["root"], phase: "ready", projectionsBySession: {
      root: {state: "loading", values: {subagentCatalog: [{id: "target", mode: "continuable"}]}},
    }});
    sessions.refreshProjections = vi.fn(() => pending.promise);
    const stop = followCompanionSession(sessions, location(), history(), workspace);
    expect(workspace.openSession).not.toHaveBeenCalled();
    expect(sessions.refreshProjections).toHaveBeenCalledWith("root");
    update({ids: ["root"], phase: "ready", projectionsBySession: {
      root: {state: "ready", values: {subagentCatalog: [{id: "target", mode: "continuable"}]}},
    }});
    expect(workspace.openSession).toHaveBeenCalledOnce();
    pending.resolve();
    await pending.promise;
    stop();
  });

  it.each(["unknown", "conflicting"])("refuses %s child addresses rather than opening a substitute", mode => {
    const {sessions, workspace} = projected({ids: ["root", "other"], phase: "ready", projectionsBySession: {
      root: {state: "ready", values: {subagentCatalog: [{id: "target", mode: mode === "unknown" ? "unknown" : "continuable"}]}},
      ...(mode === "conflicting" ? {other: {state: "ready", values: {subagentCatalog: [{id: "target", mode: "one-shot"}]}}} : {}),
    }});
    const pageHistory = history();
    const stop = followCompanionSession(sessions, location(), pageHistory, workspace);
    expect(workspace.openSession).not.toHaveBeenCalled();
    expect(pageHistory.replaceState).not.toHaveBeenCalled();
    stop();
  });

  it("does nothing when neither complete navigation capability is available", () => {
    const {sessions, workspace} = projected({ids: ["target"], phase: "ready"});
    const pageHistory = history();
    followCompanionSession(sessions, location(), pageHistory)();
    delete sessions.refreshProjections;
    followCompanionSession(sessions, location(), pageHistory, workspace)();
    expect(sessions.list.subscribe).not.toHaveBeenCalled();
    expect(sessions.refresh).not.toHaveBeenCalled();
    expect(workspace.openSession).not.toHaveBeenCalled();
    expect(pageHistory.replaceState).not.toHaveBeenCalled();
  });

  it.each(["stop", "expire", "page-change"])("cannot navigate after %s while discovery is pending", async reason => {
    vi.useFakeTimers();
    const pending = deferred();
    const {sessions, workspace, update} = projected({ids: ["root"], phase: "ready"});
    sessions.refreshProjections = vi.fn(() => pending.promise);
    const page = location();
    const pageHistory = history();
    const stop = followCompanionSession(sessions, page, pageHistory, workspace);
    if (reason === "stop") stop();
    if (reason === "expire") await vi.advanceTimersByTimeAsync(20_000);
    if (reason === "page-change") page.href = "http://127.0.0.1/#user-selected-another-session";
    update({ids: ["target"], phase: "ready"});
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(workspace.openSession).not.toHaveBeenCalled();
    expect(pageHistory.replaceState).not.toHaveBeenCalled();
    expect(sessions.refreshProjections).toHaveBeenCalledOnce();
    stop();
  });

  it("bounds modern metadata discovery to 128 identities", async () => {
    const {sessions, workspace} = projected({ids: Array.from({length: 140}, (_, index) => `root-${index}`), phase: "ready"});
    const stop = followCompanionSession(sessions, location(), history(), workspace);
    await vi.waitFor(() => expect(sessions.refreshProjections).toHaveBeenCalledTimes(128));
    await Promise.resolve();
    expect(workspace.openSession).not.toHaveBeenCalled();
    stop();
  });

  it("keeps old DSH independent of the optional workspace service", () => {
    const {sessions} = projected({ids: ["target"], phase: "ready"});
    sessions.open = vi.fn(); sessions.openSubagent = vi.fn(); sessions.refreshSubagents = vi.fn(async () => undefined);
    const injectOptional = vi.fn();
    vi.stubGlobal("window", {location: location(), history: history()});
    const stop = apply({sessions, inject: injectOptional});
    expect(inject).toEqual(["sessions"]);
    expect(injectOptional).not.toHaveBeenCalled();
    expect(sessions.open).toHaveBeenCalledExactlyOnceWith("target");
    stop();
  });

  it("waits for Cordis to supply the new workspace service and cancels late startup", () => {
    const {sessions, workspace} = projected({ids: ["target"], phase: "ready"});
    let load: ((scope: {sessions: Sessions; uiWorkspace?: WorkspaceNavigation}) => void) | undefined;
    const injectOptional = vi.fn((_dependencies: string[], callback: NonNullable<typeof load>) => {load = callback;});
    vi.stubGlobal("window", {location: location(), history: history()});
    const stop = apply({sessions, inject: injectOptional});
    expect(injectOptional).toHaveBeenCalledWith(["uiWorkspace"], expect.any(Function));
    expect(workspace.openSession).not.toHaveBeenCalled();
    stop();
    load!({sessions, uiWorkspace: workspace});
    expect(workspace.openSession).not.toHaveBeenCalled();
  });
});
