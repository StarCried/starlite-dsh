import {describe,expect,it} from "vitest";
import {questionLifecycleContract} from "../dsh-questions-contract.mjs";
const contract={
 questions:`wait?: { callId: ToolCallId; timed?: boolean; };
 type UserQuestionState = 'open' | 'continued';
 interface PendingUserQuestion { readonly callId: ToolCallId; readonly questions: readonly AskUserQuestionItem[]; readonly state: UserQuestionState; }
 readonly active: readonly PendingUserQuestion[];`,
 service:`attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{remainingMs: number;}>;
 answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean;
 class UserQuestionError extends HarnessError { constructor(message: string, code: string, options?: ErrorOptions); }`,
 fold:`interface UserQuestionFold { readonly timed: boolean; readonly questions: UserQuestionProjectionView; }
 interface SessionProjectionStateMap { userQuestions: UserQuestionProjectionState; }`,
 projections:`onChanged(listener: ProjectionChangeListener): () => void;
 stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined;`,
 agents:`get(id: SessionId): Agent | undefined; roots(): Agent[];`,
};
describe("typed public question lifecycle contracts",()=>{
 it("retains the blocking question contract on old builds without timed APIs",()=>{
  expect(questionLifecycleContract({questions:"interface Request { questions: AskUserQuestionItem[]; }"})).toEqual({kind:"blocking",missing:[]});
 });
 it("accepts the complete timed and continued public lifecycle with comments",()=>{
  expect(questionLifecycleContract({...contract,questions:contract.questions.replace("callId:","/** private Host identity */ callId:")})).toEqual({kind:"timed + continued",missing:[]});
 });
 it.each([
  ["service","signal: AbortSignal","signal: unknown","foreground claim and Host remaining duration"],
  ["service","remainingMs: number","remainingMs: string","foreground claim and Host remaining duration"],
  ["service","AskUserQuestionAnswer): boolean","AskUserQuestionAnswer): void","atomic continued answer"],
  ["service","code: string","code: number","question business error taxonomy"],
  ["questions","'continued'","'expired'","continued question states"],
  ["questions","readonly active:","readonly oldActive:","active question view"],
  ["fold","userQuestions: UserQuestionProjectionState","userQuestions: unknown","Host question projection registration"],
  ["projections","SessionProjectionStateMap[K] | undefined","unknown","authoritative Host projection read"],
  ["projections","onChanged(listener:","oldOnChanged(listener:","projection change subscription and disposal"],
  ["agents","get(id: SessionId)","get(id: string)","exact live agent lookup"],
  ["agents","roots(): Agent[]","roots(): unknown[]","live runtime root directory"],
 ])("rejects changed %s lifecycle field %s",(field,before,after,label)=>{
  expect(questionLifecycleContract({...contract,[field]:contract[field].replace(before,after)}).missing).toContain(label);
 });
 it.each(["service","fold","projections","agents"])("fails a timed declaration without %s rather than claiming complete compatibility",field=>{
  expect(questionLifecycleContract({...contract,[field]:undefined}).missing.length).toBeGreaterThan(0);
 });
});
