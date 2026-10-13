import {describe, expect, it} from "vitest";
import {navigationContract} from "../dsh-navigation-contract.mjs";

const commonSessions = "readonly list: ObservableSnapshot<SessionListState>; refresh(): Promise<void>;";
const commonList = "ids: SessionId[]; phase: SessionListPhase;";
const legacy = {
  sessions: `${commonSessions} open(id: SessionId): void; openSubagent(address: SubagentAddress): void; refreshSubagents(parentSessionId: SessionId): Promise<void>;`,
  list: `${commonList} subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>;`,
};
const projected = {
  sessions: `${commonSessions} type SessionTarget = SessionId | SubagentAddress; refreshProjections(sessionId: SessionId): Promise<void>;`,
  list: `${commonList} projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>;`,
  workspace: "uiWorkspace: UiWorkspace; openSession(target: SessionTarget): void;",
  projections: "readonly values: Readonly<Partial<SessionProjectionMap>>; readonly state: 'idle' | 'loading' | 'ready' | 'error';",
  catalog: "type SubagentCatalogEntry = { readonly id: SessionId; } & ({readonly mode: 'one-shot';} | {readonly mode: 'continuable';}); subagentCatalog: SubagentCatalogEntry[];",
};

describe("complete DSH navigation declaration contracts", () => {
  it("keeps the original navigation contract without workspace declarations", () => {
    expect(navigationContract(legacy)).toEqual({kind: "legacy", missing: []});
  });
  it("accepts workspace navigation only with the authoritative projection contract", () => {
    expect(navigationContract(projected)).toEqual({kind: "projected", missing: []});
  });
  it.each(["workspace", "projections", "catalog"])("rejects an incomplete modern %s seam", key => {
    const result = navigationContract({...projected, [key]: ""});
    expect(result.kind).toBeUndefined();
    expect(result.missing.some(label => label.startsWith("projected:"))).toBe(true);
  });
  it("does not accept similarly named navigation with a changed target", () => {
    const result = navigationContract({...projected, workspace: "uiWorkspace: UiWorkspace; openSession(target: string): Promise<void>;"});
    expect(result.kind).toBeUndefined();
    expect(result.missing).toContain("projected: workspace exact session selection");
  });
  it("requires readiness and bounded catalog refresh for both generations", () => {
    expect(navigationContract({...legacy, sessions: commonSessions}).kind).toBeUndefined();
    expect(navigationContract({...projected, list: "ids: SessionId[];"}).kind).toBeUndefined();
  });
});
