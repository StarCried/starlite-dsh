import {NAVIGATION_CHANNEL, object, opaqueRef, sessionIdentity, type NavigationRpc} from "./navigation-rpc.js";

export const inject = ["sessions"];

interface Address {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
}
interface Entry { id: string; mode?: string; kind?: string }
interface List {
  ids: string[];
  phase: string;
  subagentsByParent?: Record<string, { entries: Entry[] }>;
  projectionsBySession?: Record<string, {
    state: string;
    values: { subagentCatalog?: Entry[] };
  }>;
}
export interface Sessions {
  list: { getSnapshot(): List; subscribe(listener: () => void): () => void };
  refresh(): Promise<void>;
  open?(id: string): void;
  openSubagent?(address: Address): void;
  refreshSubagents?(id: string): Promise<void>;
  refreshProjections?(id: string): Promise<void>;
}
export interface WorkspaceNavigation {
  openSession(target: string | Address): void;
}
interface Navigation {
  open(target: string | Address): void;
  catalogs(list: List): [string, Entry[]][];
  refresh(id: string): Promise<void>;
}

function navigationFor(sessions: Sessions, workspace?: WorkspaceNavigation): Navigation | undefined {
  if (typeof sessions.open === "function" && typeof sessions.openSubagent === "function"
    && typeof sessions.refreshSubagents === "function") {
    return {
      open: target => typeof target === "string"
        ? sessions.open!(target) : sessions.openSubagent!(target),
      catalogs: list => Object.entries(list.subagentsByParent ?? {})
        .map(([parent, catalog]) => [parent, catalog.entries.filter(row => row.kind === "child")]),
      refresh: id => sessions.refreshSubagents!(id),
    };
  }
  if (typeof sessions.refreshProjections === "function" && typeof workspace?.openSession === "function") {
    return {
      open: target => workspace.openSession(target),
      catalogs: list => Object.entries(list.projectionsBySession ?? {})
        .filter(([, projection]) => projection.state === "ready" && Array.isArray(projection.values.subagentCatalog))
        .map(([parent, projection]) => [parent, projection.values.subagentCatalog!]),
      refresh: id => sessions.refreshProjections!(id),
    };
  }
  return undefined;
}

/** A navigation hint is consumed only after the authoritative list/catalog contains it. */
export function followCompanionSession(
  sessions: Sessions,
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState" | "state">,
  workspace?: WorkspaceNavigation,
): () => void {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const ids = fragment.getAll("companionSession"), id = ids[0];
  if (ids.length !== 1 || !sessionIdentity(id)) {
    return () => undefined;
  }
  const initialHref = location.href;
  return watchTarget(sessions, id, workspace, {
    current: () => location.href === initialHref,
    selected: () => {
      fragment.delete("companionSession");
      url.hash = fragment.toString();
      history.replaceState(history.state, "", url.href);
    },
  });
}

interface WatchOptions {
  current?(): boolean;
  selected?(): void;
  finished?(opened: boolean): void;
  signal?: AbortSignal;
  expiresAt?: number;
}
function watchTarget(sessions: Sessions, id: string, workspace: WorkspaceNavigation | undefined, options: WatchOptions): () => void {
  const navigation = navigationFor(sessions, workspace);
  if (!navigation || options.signal?.aborted) {options.finished?.(false); return () => undefined;}
  let done = false, discovering = false;
  const visited = new Set<string>();
  let unsubscribe: () => void = () => undefined;
  const cleanup = () => {
    done = true; unsubscribe(); clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  };
  const stop = () => {if (done) return; cleanup(); options.finished?.(false);};
  const current = () => {
    if (options.expiresAt !== undefined && Date.now() >= options.expiresAt) stop();
    if (options.current && !options.current()) stop();
    return !done;
  };
  const select = (target: string | Address) => {
    cleanup();
    try {
      navigation.open(target);
      options.selected?.();
      options.finished?.(true);
    } catch {
      // Failed navigation leaves its hint intact and never selects a substitute.
      options.finished?.(false);
    }
  };
  const inspect = () => {
    if (!current()) return;
    const list = sessions.list.getSnapshot();
    if (list.phase !== "ready") return;
    if (list.ids.includes(id)) { select(id); return; }
    const candidates = navigation.catalogs(list)
      .flatMap(([parent, entries]) => entries.filter(row => row.id === id).map(row => ({ parent, row })));
    // Conflicting catalogs or unknown modes must never select the wrong child.
    if (candidates.length === 1) {
      const { parent, row } = candidates[0]!;
      if (row.mode === "one-shot" || row.mode === "continuable") {
        select({ parentSessionId: parent, childSessionId: id, mode: row.mode });
        return;
      }
    }
    if (!discovering) {
      discovering = true;
      void discover().catch(() => undefined).finally(() => { discovering = false; });
    }
  };
  const discover = async () => {
    // Metadata only. Bounded discovery never creates sessions or sends prompts.
    while (current() && visited.size < 128) {
      const list = sessions.list.getSnapshot();
      const children = navigation.catalogs(list).flatMap(([, entries]) => entries.map(row => row.id));
      const pending = [...list.ids, ...children].find(candidate => !visited.has(candidate));
      if (!pending) break;
      visited.add(pending);
      await navigation.refresh(pending).catch(() => undefined);
      inspect();
    }
  };
  const timer = setTimeout(stop, Math.max(0, Math.min(20_000, (options.expiresAt ?? Infinity) - Date.now())));
  options.signal?.addEventListener("abort", stop, {once: true});
  unsubscribe = sessions.list.subscribe(inspect);
  inspect();
  if (current()) void sessions.refresh().then(inspect, () => undefined);
  return stop;
}

/** Opens only the requested listed/catalogued identity, with bounded cancellation. */
export function openCompanionTarget(sessions: Sessions, workspace: WorkspaceNavigation | undefined, id: string, signal: AbortSignal, expiresAt?: number): Promise<boolean> {
  if (!sessionIdentity(id)) return Promise.resolve(false);
  return new Promise(resolve => {watchTarget(sessions, id, workspace, {signal, finished: resolve, ...(expiresAt === undefined ? {} : {expiresAt})});});
}

/** Keep one long poll alive while discovery runs so reloads revoke old acknowledgements. */
export function followDesktopNavigation(
  rpc: NavigationRpc, sessions: Sessions, workspace?: WorkspaceNavigation,
  clientRef = crypto.randomUUID(),
): () => void {
  const lifetime = new AbortController();
  let active: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastRef: string | undefined;
  let busyUntil: number | undefined;
  const pause = () => new Promise<void>(resolve => {
    const cancelled = () => {clearTimeout(retry); resolve();};
    retry = setTimeout(() => {lifetime.signal.removeEventListener("abort", cancelled); resolve();}, 250);
    lifetime.signal.addEventListener("abort", cancelled, {once: true});
  });
  const acknowledge = async (requestRef: string, id: string, expiresAt: number) => {
    active?.abort();
    const selection = new AbortController();
    active = selection;
    const opened = await openCompanionTarget(sessions, workspace, id, selection.signal, expiresAt);
    if (lifetime.signal.aborted || active !== selection || selection.signal.aborted) return;
    await rpc.call(NAVIGATION_CHANNEL, "ack", {clientRef, requestRef, opened}, lifetime.signal);
  };
  const poll = async () => {
    while (!lifetime.signal.aborted) {
      try {
        const response = await rpc.call(NAVIGATION_CHANNEL, "listen", {clientRef}, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (!response.ok) {
          active?.abort();
          // During reload the old HTTP disconnect may arrive after the new page.
          // Retry only explicit ownership contention, without stealing its ACK.
          busyUntil ??= Date.now() + 20_000;
          if (response.error.code !== "starlite/navigation-busy" || Date.now() >= busyUntil) return;
          await pause(); continue;
        }
        busyUntil = undefined;
        if (response.value === null) continue;
        const command = object(response.value);
        if (!command || Object.keys(command).length !== 3 || !opaqueRef(command.requestRef) || !sessionIdentity(command.sessionId)
          || !Number.isSafeInteger(command.expiresAt) || Number(command.expiresAt) <= Date.now()) {active?.abort(); return;}
        if (command.requestRef === lastRef) continue;
        lastRef = command.requestRef;
        void acknowledge(command.requestRef, command.sessionId, Number(command.expiresAt)).catch(() => undefined);
      } catch {
        active?.abort();
        // Carrier/authentication errors are not ownership contention. A fresh
        // official connection generation can re-register through apply().
        return;
      }
    }
  };
  void poll();
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); active?.abort(); clearTimeout(retry);
    // Best effort only; cancellation of the outstanding poll also releases ownership.
    void rpc.call(NAVIGATION_CHANNEL, "release", {clientRef}).catch(() => undefined);
  };
}

function isDesktopPage(): boolean {
  const page = window as unknown as {dshDesktop?: {protocolVersion?: number}; location: Location};
  const url = new URL(page.location.href);
  return url.protocol === "dsh-app:" && url.hostname === "app" && page.dshDesktop?.protocolVersion === 1;
}

interface ClientContext {
  sessions: Sessions;
  uiWorkspace?: WorkspaceNavigation;
  connection?: {rpc?: NavigationRpc};
  on?(event: "connection/reset", listener: () => void): (() => void) | unknown;
  effect?(callback: () => () => void): unknown;
  inject?(dependencies: string[], callback: (context: ClientContext) => void): unknown;
}
export function apply(context: ClientContext): () => void {
  let disposed = false;
  let activeStop: () => void = () => undefined;
  const start = (scope: ClientContext, workspace?: WorkspaceNavigation) => {
    const mount = () => {
      if (disposed) return () => undefined;
      const desktopPage = isDesktopPage();
      // Web's child scope injects only uiWorkspace. Cordis rejects even an
      // optional read of a sibling Connection service without that dependency.
      const rpc = desktopPage ? scope.connection?.rpc : undefined;
      let stopped = false;
      let currentStop: () => void = () => undefined;
      const desktop = desktopPage && typeof rpc?.call === "function";
      const restart = () => {
        if (stopped || disposed) return;
        currentStop();
        currentStop = desktop
          ? followDesktopNavigation(rpc!, scope.sessions, workspace)
          : followCompanionSession(scope.sessions, window.location, window.history, workspace);
      };
      restart();
      const removeReset = desktop ? scope.on?.("connection/reset", restart) : undefined;
      const stop = () => {stopped = true; if (typeof removeReset === "function") removeReset(); currentStop();};
      activeStop = stop;
      return stop;
    };
    if (scope.effect) scope.effect(mount);
    else mount();
  };
  if (isDesktopPage()) {
    // Both services belong to the shared Web client; Desktop is a transport.
    context.inject?.(["connection", "uiWorkspace"], scope => start(scope, scope.uiWorkspace));
  }
  else if (navigationFor(context.sessions)) start(context);
  else if (typeof context.sessions.refreshProjections === "function") {
    // Cordis inject() waits for this optional child service and unloads its effects
    // when the service changes. Older DSH needs only the original sessions service.
    context.inject?.(["uiWorkspace"], scope => start(scope, scope.uiWorkspace));
  }
  return () => { disposed = true; activeStop(); };
}
