import {describe, expect, it} from "vitest";
import {nestedToolContract} from "../dsh-nested-tools-contract.mjs";

const declaration = `export interface PtcDispatchStartEventData {
  rootCallId: ToolCallId; parentCallId: ToolCallId; subCallId: ToolCallId;
  name: string; arguments: unknown;
}
interface SessionEventMap {
  'tool/ptc-dispatch-start': PtcDispatchStartEventData;
  'tool/ptc-dispatch': PtcDispatchEventData;
}`;

describe("DSH nested tool declaration contract", () => {
  it.each(["tools", "executor"])("accepts the same events from their %s owner", owner => {
    expect(nestedToolContract({[owner]: declaration})).toEqual([]);
  });
  it("does not use stale declarations to hide changed executor events", () => {
    expect(nestedToolContract({tools: declaration, executor: declaration.replace("subCallId: ToolCallId", "subCallId: number")}))
      .toEqual(["nested tool start shape"]);
  });
  it("requires both start and finish events", () => {
    expect(nestedToolContract({executor: declaration.replace("'tool/ptc-dispatch':", "'tool/result':")}))
      .toEqual(["nested tool finish event"]);
    expect(nestedToolContract({executor: declaration.replace("'tool/ptc-dispatch-start':", "'tool/start':")}))
      .toEqual(["nested tool start event"]);
  });
  it("fails closed when neither public owner is available", () => {
    expect(nestedToolContract({})).toHaveLength(3);
  });
});
