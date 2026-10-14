/** Validate the complete public navigation seam used by each supported DSH client. */
export function navigationContract(sources) {
  const common = [
    ["observable session list", sources.sessions, /readonly\s+list:\s*ObservableSnapshot<SessionListState>;/u],
    ["session list identities", sources.list, /ids:\s*SessionId\[\];/u],
    ["session list readiness", sources.list, /phase:\s*SessionListPhase;/u],
    ["session metadata refresh", sources.sessions, /refresh\(\):\s*Promise<void>;/u],
  ];
  const legacy = [
    ["exact web session selection", sources.sessions, /open\(id: SessionId\): void;/u],
    ["catalog navigation", sources.sessions, /openSubagent\(address: SubagentAddress\): void;/u],
    ["legacy catalog refresh", sources.sessions, /refreshSubagents\(parentSessionId:\s*SessionId\):\s*Promise<void>;/u],
    ["legacy authoritative catalogs", sources.list, /subagentsByParent:\s*Readonly<Record<SessionId,\s*SubagentCatalogSnapshot>>;/u],
  ];
  const projected = [
    ["workspace navigation context", sources.workspace, /uiWorkspace:\s*UiWorkspace;/u],
    ["workspace exact session selection", sources.workspace, /openSession\(target:\s*SessionTarget\):\s*void;/u],
    ["workspace session target", sources.sessions, /type\s+SessionTarget\s*=\s*SessionId\s*\|\s*SubagentAddress;/u],
    ["projection catalog refresh", sources.sessions, /refreshProjections\(sessionId:\s*SessionId\):\s*Promise<void>;/u],
    ["authoritative session projections", sources.list, /projectionsBySession:\s*Readonly<Record<SessionId,\s*SessionProjectionSnapshot>>;/u],
    ["projection values", sources.projections, /readonly\s+values:\s*Readonly<Partial<SessionProjectionMap>>;/u],
    ["projection readiness", sources.projections, /readonly\s+state:\s*'idle'\s*\|\s*'loading'\s*\|\s*'ready'\s*\|\s*(?:'migration-required'\s*\|\s*)?'error';/u],
    ["subagent catalog projection", sources.catalog, /subagentCatalog:\s*SubagentCatalogEntry\[\];/u],
    ["subagent catalog identity", sources.catalog, /type\s+SubagentCatalogEntry\s*=\s*\{\s*readonly\s+id:\s*SessionId;/u],
    ["one-shot subagent mode", sources.catalog, /readonly\s+mode:\s*'one-shot';/u],
    ["continuable subagent mode", sources.catalog, /readonly\s+mode:\s*'continuable';/u],
  ];
  const missing = requirements => requirements.filter(([, contents, pattern]) => !pattern.test(contents ?? "")).map(([label]) => label);
  const commonMissing = missing(common);
  const legacyMissing = missing(legacy);
  const projectedMissing = missing(projected);
  if (!commonMissing.length && !legacyMissing.length) return { kind: "legacy", missing: [] };
  if (!commonMissing.length && !projectedMissing.length) return { kind: "projected", missing: [] };
  return {
    kind: undefined,
    missing: [...commonMissing, ...legacyMissing.map(label => `legacy: ${label}`), ...projectedMissing.map(label => `projected: ${label}`)],
  };
}
