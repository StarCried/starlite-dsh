import { randomUUID } from "node:crypto";
import { DshStateAggregator, type AgentRunStatus, type DshEventLike } from "./aggregator.js";
import { isWslEnvironment, launchWindowsPet } from "./launcher.js";
import { startStatusServer, type StatusServer } from "./server.js";
import { DeepSeekBilling, type BillingContext } from "./billing.js";
import {QuestionBridge} from "./questions.js";
import {openDshSession} from "./navigation.js";

type Listener = (...arguments_: unknown[]) => unknown;
type Disposer = () => void | Promise<void>;

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface CordisContextLike extends BillingContext {
  on(event: string, listener: Listener, options?: {prepend?:boolean}): unknown;
  logger?: LoggerLike;
}

export interface AdapterDependencies {
  readonly isWsl?: () => boolean;
  readonly startServer?: typeof startStatusServer;
  readonly launch?: typeof launchWindowsPet;
  readonly openBrowser?: (url:string)=>Promise<void>;
}

export async function startDshAdapter(
  context: CordisContextLike,
  dependencies: AdapterDependencies = {},
): Promise<Disposer> {
  if (!context || typeof context.on !== "function") {
    throw new Error("incompatible DSH context: event subscription is unavailable");
  }
  if (!(dependencies.isWsl ?? isWslEnvironment)()) {
    throw new Error("this alpha requires DSH to run inside WSL2");
  }

  const aggregator = new DshStateAggregator();
  const billing = new DeepSeekBilling(context);
  const questions = new QuestionBridge(aggregator,key=>openDshSession(context,key,dependencies.openBrowser));
  const server = await (dependencies.startServer ?? startStatusServer)(aggregator, {billing,questions});
  const refreshTitle=(key:unknown)=>{
    try{const service=asRecord(context.get?.("sessionTitle"));const value=typeof service?.get==="function"?asRecord(service.get.call(service,key)):undefined;
      aggregator.sessionInfo(key,typeof value?.title==="string"?value.title:undefined);
    }catch{aggregator.sessionInfo(key)}
  };
  const disposers: Disposer[] = [];
  let approvalSequence = 0;

  try {
    subscribeRequired(context, disposers, "agent/status", (...arguments_) => {
      const payload = asRecord(arguments_[0]);
      const agent = payload?.agent;
      const status = payload?.status;
      if ((status === "idle" || status === "running") && agent) {
        refreshTitle(subjectKey(agent));
        aggregator.handleAgentStatus(subjectKey(agent), status as AgentRunStatus);
      }
    });
    subscribeRequired(context, disposers, "agent/error", (...arguments_) => {
      const payload = asRecord(arguments_[0]);
      if (payload?.agent) {const key=subjectKey(payload.agent);questions.cancelSession(key);refreshTitle(key);aggregator.handleAgentError(key);}
    });
    subscribeRequired(context, disposers, "agent/assistant-stream", (...arguments_) => {
      const payload = asRecord(arguments_[0]);
      if (payload?.agent) {
        refreshTitle(subjectKey(payload.agent));
        aggregator.handleAssistantStream(subjectKey(payload.agent), payload.frame);
      }
    });
    subscribeRequired(context, disposers, "session/event", (...arguments_) => {
      const session = arguments_[0];
      const event = asRecord(arguments_[1]);
      if (session && typeof event?.type === "string") {
        const key=subjectKey(session);refreshTitle(key);
        if(event.type==="turn/end")questions.cancelSession(key);
        aggregator.handleSessionEvent(subjectKey(session), event as unknown as DshEventLike);
        if (event.type === "assistant/message" || event.type === "assistant/attempt") billing.invalidate();
      }
    });
    subscribeRequired(context, disposers, "approval/request", async (...arguments_) => {
      const request = asRecord(arguments_[0]);
      const next = arguments_[1];
      if (typeof next !== "function") {
        // Do not invent a result for a changed waterfall contract. The daily
        // declaration guard should catch this before a release reaches users.
        return undefined;
      }
      if (!request?.agent) return next();
      const key = subjectKey(request.agent);
      const approvalKey = String(approvalSequence);
      approvalSequence += 1;
      aggregator.handleApprovalRequested(key, approvalKey, request.toolName);
      try {
        return await next();
      } finally {
        aggregator.handleApprovalResolved(key, approvalKey);
      }
    });
    subscribeRequired(context,disposers,"user-questions/request",(...arguments_)=>{
      const request=asRecord(arguments_[0]),next=arguments_[1];
      if(typeof next!=="function")return undefined;
      if(!request?.agent)return next();
      const key=subjectKey(request.agent);refreshTitle(key);
      return questions.ask(key,request,next as ()=>Promise<unknown>);
    },{prepend:true});
    subscribeOptional(context, disposers, "agent/disposed", (...arguments_) => {
      const payload = asRecord(arguments_[0]);
      if (payload?.agent) {const key=subjectKey(payload.agent);questions.cancelSession(key);aggregator.disposeSession(key);}
    });
    for (const event of ["settings/updated", "credentials/reference-updated", "credentials/record-updated"]) {
      subscribeOptional(context, disposers, event, () => billing.invalidate(true));
    }
  } catch (error) {
    questions.close();billing.close();
    await closeAdapter(disposers, server);
    throw error;
  }

  void (dependencies.launch ?? launchWindowsPet)({
    port: server.port,
    token: server.token,
    instanceId: randomUUID(),
  }).catch(() => {
    context.logger?.warn?.(
      "DSH Companion could not start the Windows companion; DSH will continue without it.",
    );
  });
  context.logger?.info?.("DSH Companion status bridge is ready.");

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    billing.close();
    questions.close();
    await closeAdapter(disposers, server);
  };
}

function subscribeRequired(
  context: CordisContextLike,
  disposers: Disposer[],
  event: string,
  listener: Listener,
  options?: {prepend?:boolean},
): void {
  const result = context.on(event, listener, options);
  if (typeof result === "function") disposers.push(result as Disposer);
}

function subscribeOptional(
  context: CordisContextLike,
  disposers: Disposer[],
  event: string,
  listener: Listener,
): void {
  try {
    subscribeRequired(context, disposers, event, listener);
  } catch {
    // Older preview builds may not expose disposal. Core status events remain
    // mandatory, while a missing optional lifecycle signal must not stop DSH.
  }
}

async function closeAdapter(disposers: Disposer[], server: StatusServer): Promise<void> {
  const tasks = disposers.splice(0).reverse().map(async (dispose) => dispose());
  tasks.push(server.close());
  await Promise.allSettled(tasks);
}

function subjectKey(subject: unknown): unknown {
  const record = asRecord(subject);
  return record?.session ?? subject;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
