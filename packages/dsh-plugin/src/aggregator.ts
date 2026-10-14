import {
  PET_PROTOCOL_VERSION,
  sanitizeBubbleText,
  type BubbleKind,
  type PetBubble,
  type PetSnapshot,
  type PetState,
  type PetStateSource,
  type PetSession,
  type PetActivity,
} from "@starcried/starlite-dsh-protocol";
import {randomUUID} from "node:crypto";

const COMPLETED_LATCH_MS = 6_000;
const ERROR_LATCH_MS = 8_000;
const CONTENT_THROTTLE_MS = 200;
const QUESTION_TOOLS = new Set(["ask_user_question", "request_user_input"]);

type Timer = ReturnType<typeof setTimeout>;

export interface AggregatorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
}

export type AgentRunStatus = "idle" | "running";

export interface DshEventLike {
  readonly type: string;
  readonly data?: unknown;
}

interface TimedText {
  readonly text: string;
  readonly at: number;
  readonly endsWithWhitespace: boolean;
}

interface TimedTool {
  readonly name: string;
  readonly at: number;
}

interface SessionState {
  ref: string;
  title: string;
  compacting: boolean;
  inputs: Map<string, {at:number;blocking:boolean}>;
  activityAt: number;
  running: boolean;
  turnActive: boolean;
  blockedAt: number | undefined;
  completedUntil: number | undefined;
  completedAt: number | undefined;
  errorUntil: number | undefined;
  errorAt: number | undefined;
  reasoning: TimedText | undefined;
  response: TimedText | undefined;
  activeTools: Map<string, TimedTool>;
  approvals: Map<string, TimedTool>;
}

interface Candidate {
  readonly session?: PetSession;
  readonly activity?: PetActivity;
  readonly inputRequest?: string;
  readonly state: PetState;
  readonly bubble?: PetBubble;
  readonly at: number;
}

const systemClock: AggregatorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Reduces every session in one DSH process to the deliberately small wire
 * contract. Event payloads are parsed field-by-field so sensitive DSH fields
 * are neither copied nor serialized accidentally.
 */
export class DshStateAggregator implements PetStateSource {
  readonly #clock: AggregatorClock;
  readonly #sessions = new Map<unknown, SessionState>();
  #emit: ((snapshot: PetSnapshot) => void) | undefined;
  #sequence = 0;
  #lastEmittedAt = Number.NEGATIVE_INFINITY;
  #lastKey: string | undefined;
  #lastState: PetState | undefined;
  #lastInput: string | undefined;
  #contentTimer: Timer | undefined;
  #deadlineTimer: Timer | undefined;

  constructor(clock: AggregatorClock = systemClock) {
    this.#clock = clock;
  }

  async start(emit: (snapshot: PetSnapshot) => void): Promise<void> {
    if (this.#emit) {
      throw new Error("DSH pet state source is already started");
    }
    this.#emit = emit;
    this.#publish(true);
  }

  async stop(): Promise<void> {
    this.#clearTimers();
    this.#emit = undefined;
    this.#lastKey = undefined;
    this.#lastState = undefined;
    this.#lastInput = undefined;
  }

  handleAgentStatus(key: unknown, status: AgentRunStatus): void {
    const session = this.#session(key);
    session.activityAt = this.#clock.now();
    session.running = status === "running";
    this.#changed();
  }

  sessionInfo(key: unknown, title?: string): PetSession {
    const session=this.#session(key);
    const clean=sanitizeBubbleText(title,80);
    if(clean && clean!==session.title){session.title=clean;this.#changed();}
    return {ref:session.ref,title:session.title};
  }
  sessionKey(ref: string): unknown {return [...this.#sessions].find(([,session])=>session.ref===ref)?.[0]}
  handleInputRequested(key: unknown, requestId: string, blocking=true): void {
    const session=this.#session(key);session.inputs.set(requestId,{at:this.#clock.now(),blocking});this.#changed();
  }
  handleInputResolved(key: unknown, requestId: string): void {
    if(this.#sessions.get(key)?.inputs.delete(requestId))this.#changed();
  }

  handleAgentError(key: unknown): void {
    const now = this.#clock.now();
    const session = this.#session(key);
    session.activityAt = now;
    session.errorAt = now;
    session.errorUntil = now + ERROR_LATCH_MS;
    session.running = false;
    session.turnActive = false;
    session.compacting = false;
    session.activeTools.clear();
    session.approvals.clear();
    this.#changed();
  }

  handleAssistantStream(key: unknown, rawFrame: unknown): void {
    const frame = asRecord(rawFrame);
    if (frame?.type !== "start" && frame?.type !== "chunk") return;
    const session = this.#session(key);
    const now = this.#clock.now();
    if (frame.type === "start") {
      // DSH 0.1.5 publishes live chunks outside the durable session log. A new
      // attempt must not concatenate its text with a previous step or retry.
      session.reasoning = undefined;
      session.response = undefined;
    } else {
      handleAssistantChunk(session, frame, now);
    }
    session.activityAt = now;
    this.#changed();
  }

  handleApprovalRequested(key: unknown, approvalKey: string, toolName: unknown): void {
    const name = safeToolName(typeof toolName === "string" ? toolName : undefined);
    if (!approvalKey || !name) return;
    const session = this.#session(key);
    session.activityAt = this.#clock.now();
    session.approvals.set(`live:${approvalKey}`, {
      name,
      at: session.activityAt,
    });
    this.#changed();
  }

  handleApprovalResolved(key: unknown, approvalKey: string): void {
    const session = this.#sessions.get(key);
    if (session?.approvals.delete(`live:${approvalKey}`)) {
      session.activityAt = this.#clock.now();
      this.#changed();
    }
  }

  handleSessionEvent(key: unknown, event: DshEventLike): void {
    if (!event || typeof event.type !== "string") return;
    const data = asRecord(event.data);
    const now = this.#clock.now();
    const session = this.#session(key);

    switch (event.type) {
      case "session/title": {
        const title=sanitizeBubbleText(data?.title,80);
        if(title)session.title=title;
        this.#changed();return;
      }
      case "compaction/start": session.compacting=true; break;
      case "compaction/end": session.compacting=false; break;
      case "turn/start":
        resetForTurn(session);
        session.turnActive = true;
        break;
      case "turn/end":
        this.#handleTurnEnd(session, turnEndKind(data), now);
        break;
      case "assistant/chunk":
        handleAssistantChunk(session, data, now);
        break;
      case "assistant/message":
        handleAssistantMessage(session, data, now);
        break;
      case "tool/call":
        handleToolStarted(session, data, now, "callId");
        break;
      case "tool/result":
        handleToolSettled(session, data);
        break;
      case "tool/code-dispatch-start":
      case "tool/ptc-dispatch-start":
        handleToolStarted(session, data, now, "subCallId");
        break;
      case "tool/code-dispatch":
      case "tool/ptc-dispatch":
        removeCall(session, stringField(data, "subCallId"));
        break;
      case "approval/asked":
        addApproval(session, data, now);
        break;
      case "approval/decided":
        removeApproval(session, stringField(data, "id"));
        break;
      case "step/start":
      case "step/end":
        break;
      default:
        return;
    }
    session.activityAt = now;
    this.#changed();
  }

  disposeSession(key: unknown): void {
    if (this.#sessions.delete(key)) this.#changed();
  }

  #handleTurnEnd(session: SessionState, reason: string | undefined, now: number): void {
    session.compacting = false;
    session.turnActive = false;
    session.running = false;
    session.activeTools.clear();
    session.approvals.clear();
    session.blockedAt = undefined;
    session.completedAt = undefined;
    session.completedUntil = undefined;
    session.errorAt = undefined;
    session.errorUntil = undefined;

    if (reason === "completed") {
      session.completedAt = now;
      session.completedUntil = now + COMPLETED_LATCH_MS;
    } else if (reason === "blocked") {
      session.blockedAt = now;
    } else if (reason === "error") {
      session.errorAt = now;
      session.errorUntil = now + ERROR_LATCH_MS;
    }
  }

  #session(key: unknown): SessionState {
    let session = this.#sessions.get(key);
    if (!session) {
      session = {
        ref:randomUUID(), title:"DSH 会话", compacting:false, inputs:new Map(),
        activityAt: this.#clock.now(),
        running: false,
        turnActive: false,
        blockedAt: undefined,
        completedUntil: undefined,
        completedAt: undefined,
        errorUntil: undefined,
        errorAt: undefined,
        reasoning: undefined,
        response: undefined,
        activeTools: new Map(),
        approvals: new Map(),
      };
      this.#sessions.set(key, session);
    }
    return session;
  }

  #changed(): void {
    this.#scheduleDeadline();
    this.#publish(false);
  }

  #publish(force: boolean): void {
    if (!this.#emit) return;
    const now = this.#clock.now();
    const candidate = selectCandidate(this.#sessions.values(), now);
    const key = candidateKey(candidate);
    if (!force && key === this.#lastKey) return;

    const stateChanged = candidate.state !== this.#lastState || candidate.inputRequest !== this.#lastInput;
    const elapsed = now - this.#lastEmittedAt;
    if (!force && !stateChanged && elapsed < CONTENT_THROTTLE_MS) {
      if (!this.#contentTimer) {
        this.#contentTimer = this.#clock.setTimeout(() => {
          this.#contentTimer = undefined;
          this.#publish(true);
        }, CONTENT_THROTTLE_MS - Math.max(0, elapsed));
      }
      return;
    }

    if (this.#contentTimer) {
      this.#clock.clearTimeout(this.#contentTimer);
      this.#contentTimer = undefined;
    }
    const snapshot: PetSnapshot = {
      protocolVersion: PET_PROTOCOL_VERSION,
      sequence: this.#sequence,
      emittedAt: now,
      state: candidate.state,
      ...(candidate.bubble ? { bubble: candidate.bubble } : {}),
      ...(candidate.session?{session:candidate.session}:{}),
      ...(candidate.activity?{activity:candidate.activity}:{}),
      ...(candidate.inputRequest?{inputRequest:candidate.inputRequest}:{}),
    };
    this.#sequence += 1;
    this.#lastEmittedAt = now;
    this.#lastKey = key;
    this.#lastState = candidate.state;
    this.#lastInput = candidate.inputRequest;
    this.#emit(snapshot);
  }

  #scheduleDeadline(): void {
    if (this.#deadlineTimer) {
      this.#clock.clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    const now = this.#clock.now();
    let next = Number.POSITIVE_INFINITY;
    for (const session of this.#sessions.values()) {
      if (session.completedUntil && session.completedUntil > now) {
        next = Math.min(next, session.completedUntil);
      }
      if (session.errorUntil && session.errorUntil > now) {
        next = Math.min(next, session.errorUntil);
      }
    }
    if (Number.isFinite(next)) {
      this.#deadlineTimer = this.#clock.setTimeout(() => {
        this.#deadlineTimer = undefined;
        this.#changed();
      }, Math.max(1, next - now));
    }
  }

  #clearTimers(): void {
    if (this.#contentTimer) this.#clock.clearTimeout(this.#contentTimer);
    if (this.#deadlineTimer) this.#clock.clearTimeout(this.#deadlineTimer);
    this.#contentTimer = undefined;
    this.#deadlineTimer = undefined;
  }
}

function resetForTurn(session: SessionState): void {
  session.compacting = false;
  session.blockedAt = undefined;
  session.completedAt = undefined;
  session.completedUntil = undefined;
  session.errorAt = undefined;
  session.errorUntil = undefined;
  session.reasoning = undefined;
  session.response = undefined;
  session.activeTools.clear();
  session.approvals.clear();
}

function handleAssistantChunk(session: SessionState, data: Record<string, unknown> | undefined, now: number): void {
  const chunk = asRecord(data?.chunk);
  const type = stringField(chunk, "type");
  const text = stringField(chunk, "text");
  if (!text || (type !== "reasoning-delta" && type !== "text-delta")) return;
  if (type === "reasoning-delta") {
    session.reasoning = appendVisible(session.reasoning, text, now);
  } else {
    session.response = appendVisible(session.response, text, now);
  }
}

function handleAssistantMessage(session: SessionState, data: Record<string, unknown> | undefined, now: number): void {
  const message = asRecord(data?.message);
  if (!message || !Array.isArray(message.content)) return;
  let response: TimedText | undefined;
  let reasoning: TimedText | undefined;
  for (const rawBlock of message.content) {
    const block = asRecord(rawBlock);
    const type = stringField(block, "type");
    const text = stringField(block, "text");
    if (!text) continue;
    if (type === "text") response = appendVisible(response, text, now);
    if (type === "reasoning") reasoning = appendVisible(reasoning, text, now);
  }
  if (response) session.response = response;
  if (reasoning) session.reasoning = reasoning;
}

function appendVisible(previous: TimedText | undefined, addition: string, now: number): TimedText | undefined {
  // Wire text is trimmed. Keep one separator bit in memory so a space-only
  // chunk or a chunk ending in whitespace does not join the next word.
  const separator = previous?.endsWithWhitespace ? " " : "";
  const text = sanitizeBubbleText(`${previous?.text ?? ""}${separator}${addition}`);
  return text ? { text, at: now, endsWithWhitespace: /\s$/u.test(addition) } : previous;
}

function handleToolStarted(
  session: SessionState,
  data: Record<string, unknown> | undefined,
  now: number,
  idField: string,
): void {
  const id = stringField(data, idField);
  const name = safeToolName(stringField(data, "name"));
  if (!id || !name) return;
  const item = { name, at: now };
  if (QUESTION_TOOLS.has(name)) session.approvals.set(`tool:${id}`, item);
  else session.activeTools.set(id, item);
}

function handleToolSettled(session: SessionState, data: Record<string, unknown> | undefined): void {
  const direct = stringField(data, "callId");
  const message = asRecord(data?.message);
  const source = asRecord(message?.source);
  removeCall(session, direct ?? stringField(source, "callId"));
}

function removeCall(session: SessionState, id: string | undefined): void {
  if (!id) return;
  session.activeTools.delete(id);
  session.approvals.delete(`tool:${id}`);
}

function addApproval(session: SessionState, data: Record<string, unknown> | undefined, now: number): void {
  const id = stringField(data, "id");
  const name = safeToolName(stringField(data, "toolName"));
  if (id && name) session.approvals.set(`approval:${id}`, { name, at: now });
}

function removeApproval(session: SessionState, id: string | undefined): void {
  if (id) session.approvals.delete(`approval:${id}`);
}

function selectCandidate(sessions: Iterable<SessionState>, now: number): Candidate {
  const all = [...sessions];
  let error: Candidate | undefined;
  let approval: Candidate | undefined;
  let blocked: Candidate | undefined;
  let working: Candidate | undefined;
  let thinking: Candidate | undefined;
  let completed: Candidate | undefined;

  for (const session of all) {
    const wrap=(candidate:Candidate,activity:PetActivity):Candidate=>({...candidate,session:{ref:session.ref,title:session.title},activity});
    if (session.errorUntil && session.errorUntil > now) {
      error = newest(error, wrap(notice("error", "发生错误，请查看 DSH", session.errorAt ?? now),"error"));
    }
    const input=[...session.inputs].filter(([,item])=>item.blocking).at(-1);
    if(input)approval=newest(approval,{...wrap(notice("approval","等待输入…",input[1].at),"waiting"),inputRequest:input[0]});
    const currentApproval = newestMapValue(session.approvals);
    if (currentApproval) {
      if(!input)approval = newest(approval, wrap(notice("approval", QUESTION_TOOLS.has(currentApproval.name)?"等待输入…":`等待批准：${currentApproval.name}`, currentApproval.at),"waiting"));
    }
    if (session.blockedAt !== undefined) {
      blocked = newest(blocked, wrap(notice("blocked", "任务被阻塞，请查看 DSH", session.blockedAt),"blocked"));
    }
    const currentTool = newestMapValue(session.activeTools);
    if (currentTool) {
      working = newest(working, wrap({
        state: "working",
        bubble: bubble("tool", `正在使用 ${currentTool.name}…`),
        at: currentTool.at,
      },toolActivity(currentTool.name)));
    }
    if(session.compacting)working=newest(working,wrap(notice("working","正在压缩上下文…",session.activityAt),"compacting"));
    if (session.running || session.turnActive) {
      const visible = latestVisible(session);
      thinking = newest(thinking, wrap({
        state: "thinking",
        bubble: visible
          ? bubble(visible === session.response ? "response" : "reasoning", visible.text)
          : bubble("notice", "思考中…"),
        at: visible?.at ?? session.activityAt,
      },visible===session.response && visible?"responding":"thinking"));
    }
    if (session.completedUntil && session.completedUntil > now) {
      completed = newest(completed, wrap({
        state: "completed",
        bubble: session.response
          ? bubble("response", session.response.text)
          : bubble("notice", "任务已完成"),
        at: session.completedAt ?? now,
      },"completed"));
    }
  }

  const selected=error ?? approval ?? blocked ?? working ?? thinking ?? completed;
  // Continued questions no longer block the Host's turn. Keep its real state
  // and animation, and expose an answer form only for the selected session.
  // Foreground questions and tool permissions always take precedence.
  if(selected){
    if(selected.state==="approval"||selected.state==="error")return selected;
    const session=all.find(item=>item.ref===selected.session?.ref);
    const late=session&&[...session.inputs].filter(([,item])=>!item.blocking).at(-1);
    return late?{...selected,inputRequest:late[0]}:selected;
  }
  const last=all.sort((a,b)=>b.activityAt-a.activityAt)[0];
  const late=last&&[...last.inputs].filter(([,item])=>!item.blocking).at(-1);
  return {state:"idle",at:now,activity:"idle",...(last?{session:{ref:last.ref,title:last.title}}:{}),...(late?{inputRequest:late[0]}:{})};
}

function notice(state: PetState, text: string, at: number): Candidate {
  return { state, bubble: bubble("notice", text), at };
}

function bubble(kind: BubbleKind, rawText: string): PetBubble {
  const text = sanitizeBubbleText(rawText);
  return { kind, text };
}

function latestVisible(session: SessionState): TimedText | undefined {
  if (!session.reasoning) return session.response;
  if (!session.response) return session.reasoning;
  return session.response.at >= session.reasoning.at ? session.response : session.reasoning;
}

function newest(current: Candidate | undefined, next: Candidate): Candidate {
  return !current || next.at >= current.at ? next : current;
}

function newestMapValue(values: Map<string, TimedTool>): TimedTool | undefined {
  let result: TimedTool | undefined;
  for (const item of values.values()) {
    if (!result || item.at >= result.at) result = item;
  }
  return result;
}

function candidateKey(candidate: Candidate): string {
  return JSON.stringify([candidate.state,candidate.bubble,candidate.session,candidate.activity,candidate.inputRequest]);
}

export function toolActivity(name: string): PetActivity {
  if(/^(?:bash|pwsh|shell|run_command|execute_command)$/iu.test(name))return "command";
  if(/^(?:edit|write)$/iu.test(name)||/(?:str_replace|edit_file|write_file|apply_patch|create_file)/iu.test(name))return "editing";
  if(/^(?:read|read_image|ls)$/iu.test(name)||/(?:read_file|list_files|fs_read|fs_list)/iu.test(name))return "reading";
  if(/^glob$/iu.test(name)||/(?:search|grep|find_files)/iu.test(name))return "searching";
  return "tool";
}

function safeToolName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = sanitizeBubbleText(value, 60);
  return clean || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function turnEndKind(data: Record<string, unknown> | undefined): string | undefined {
  return stringField(asRecord(data?.reason), "kind");
}
