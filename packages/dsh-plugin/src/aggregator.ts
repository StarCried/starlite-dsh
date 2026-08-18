import {
  PET_PROTOCOL_VERSION,
  sanitizeBubbleText,
  type BubbleKind,
  type PetBubble,
  type PetSnapshot,
  type PetState,
  type PetStateSource,
} from "@dsh-inochi2d-pet/protocol";

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
}

interface TimedTool {
  readonly name: string;
  readonly at: number;
}

interface SessionState {
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
  }

  handleAgentStatus(key: unknown, status: AgentRunStatus): void {
    const session = this.#session(key);
    session.activityAt = this.#clock.now();
    session.running = status === "running";
    this.#changed();
  }

  handleAgentError(key: unknown): void {
    const now = this.#clock.now();
    const session = this.#session(key);
    session.activityAt = now;
    session.errorAt = now;
    session.errorUntil = now + ERROR_LATCH_MS;
    session.running = false;
    session.turnActive = false;
    session.activeTools.clear();
    session.approvals.clear();
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
        handleToolStarted(session, data, now, "subCallId");
        break;
      case "tool/code-dispatch":
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

    const stateChanged = candidate.state !== this.#lastState;
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
    };
    this.#sequence += 1;
    this.#lastEmittedAt = now;
    this.#lastKey = key;
    this.#lastState = candidate.state;
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
  let response = "";
  let reasoning = "";
  for (const rawBlock of message.content) {
    const block = asRecord(rawBlock);
    const type = stringField(block, "type");
    const text = stringField(block, "text");
    if (!text) continue;
    if (type === "text") response = sanitizeBubbleText(`${response}${text}`);
    if (type === "reasoning") reasoning = sanitizeBubbleText(`${reasoning}${text}`);
  }
  const cleanResponse = sanitizeBubbleText(response);
  const cleanReasoning = sanitizeBubbleText(reasoning);
  if (cleanResponse) session.response = { text: cleanResponse, at: now };
  if (cleanReasoning) session.reasoning = { text: cleanReasoning, at: now };
}

function appendVisible(previous: TimedText | undefined, addition: string, now: number): TimedText | undefined {
  const text = sanitizeBubbleText(`${previous?.text ?? ""}${addition}`);
  return text ? { text, at: now } : previous;
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
  let error: Candidate | undefined;
  let approval: Candidate | undefined;
  let blocked: Candidate | undefined;
  let working: Candidate | undefined;
  let thinking: Candidate | undefined;
  let completed: Candidate | undefined;

  for (const session of sessions) {
    if (session.errorUntil && session.errorUntil > now) {
      error = newest(error, notice("error", "发生错误，请查看 DSH", session.errorAt ?? now));
    }
    const currentApproval = newestMapValue(session.approvals);
    if (currentApproval) {
      approval = newest(approval, notice("approval", `等待批准：${currentApproval.name}`, currentApproval.at));
    }
    if (session.blockedAt !== undefined) {
      blocked = newest(blocked, notice("blocked", "任务被阻塞，请查看 DSH", session.blockedAt));
    }
    const currentTool = newestMapValue(session.activeTools);
    if (currentTool) {
      working = newest(working, {
        state: "working",
        bubble: bubble("tool", `正在使用 ${currentTool.name}…`),
        at: currentTool.at,
      });
    }
    if (session.running || session.turnActive) {
      const visible = latestVisible(session);
      thinking = newest(thinking, {
        state: "thinking",
        bubble: visible
          ? bubble(visible === session.response ? "response" : "reasoning", visible.text)
          : bubble("notice", "思考中…"),
        at: visible?.at ?? session.activityAt,
      });
    }
    if (session.completedUntil && session.completedUntil > now) {
      completed = newest(completed, {
        state: "completed",
        bubble: session.response
          ? bubble("response", session.response.text)
          : bubble("notice", "任务已完成"),
        at: session.completedAt ?? now,
      });
    }
  }

  return error ?? approval ?? blocked ?? working ?? thinking ?? completed ?? { state: "idle", at: now };
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
  return `${candidate.state}\u0000${candidate.bubble?.kind ?? ""}\u0000${candidate.bubble?.text ?? ""}`;
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
