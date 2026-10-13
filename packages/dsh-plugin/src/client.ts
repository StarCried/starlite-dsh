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
  if (ids.length !== 1 || !id || id.length > 256 || Array.from(id).some(c => c.charCodeAt(0) < 32)) {
    return () => undefined;
  }
  const navigation = navigationFor(sessions, workspace);
  if (!navigation) return () => undefined;
  const initialHref = location.href;
  let done = false, discovering = false;
  const visited = new Set<string>();
  let unsubscribe: () => void = () => undefined;
  const stop = () => { done = true; unsubscribe(); clearTimeout(timer); };
  const current = () => {
    if (location.href !== initialHref) stop();
    return !done;
  };
  const select = (target: string | Address) => {
    stop();
    try {
      navigation.open(target);
      fragment.delete("companionSession");
      url.hash = fragment.toString();
      history.replaceState(history.state, "", url.href);
    } catch {
      // Failed navigation leaves its hint intact and never selects a substitute.
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
  const timer = setTimeout(stop, 20_000);
  unsubscribe = sessions.list.subscribe(inspect);
  inspect();
  if (current()) void sessions.refresh().then(inspect, () => undefined);
  return stop;
}

interface ClientContext {
  sessions: Sessions;
  uiWorkspace?: WorkspaceNavigation;
  effect?(callback: () => () => void): unknown;
  inject?(dependencies: string[], callback: (context: ClientContext) => void): unknown;
}
export function apply(context: ClientContext): () => void {
  let disposed = false;
  let activeStop: () => void = () => undefined;
  const start = (scope: ClientContext, workspace?: WorkspaceNavigation) => {
    const mount = () => {
      if (disposed) return () => undefined;
      const stop = followCompanionSession(scope.sessions, window.location, window.history, workspace);
      activeStop = stop;
      return stop;
    };
    if (scope.effect) scope.effect(mount);
    else mount();
  };
  if (navigationFor(context.sessions)) start(context);
  else if (typeof context.sessions.refreshProjections === "function") {
    // Cordis inject() waits for this optional child service and unloads its effects
    // when the service changes. Older DSH needs only the original sessions service.
    context.inject?.(["uiWorkspace"], scope => start(scope, scope.uiWorkspace));
  }
  return () => { disposed = true; activeStop(); };
}
