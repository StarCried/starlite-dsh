import { SessionControl } from "./session-control.js";

interface ToolContext { get?(name: string): unknown; logger?: { warn?(message: string): void } }
interface Execution { agent: { session: unknown }; signal: AbortSignal }
interface NativeTool {
  name: string; description: string; parameters: object; timeoutMs: number;
  output: { schema: object; render(args: unknown, value: unknown): Array<{ type: "text"; text: string }> };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}
const skill = {
  name: "starlite-character", source: "runtime",
  description: "Use the user's StarLite desktop character for an explicitly requested embodied conversation: named animations, short plain-text speech and temporary stage placement.",
  content: `# StarLite character interaction

Use this skill only when the user asks to interact through their StarLite character. Respect the user's existing persona; do not invent a new identity or claim that a model's visual likeness belongs to you.

1. Call starlite_inspect first. If disabled, ask the user to enable Session control in StarLite settings; do not change settings files or use shell commands to bypass it. If unavailable or busy, explain briefly and continue ordinary conversation.
2. Call starlite_control with action acquire. Only the current DSH session owns the lease; never pass session identifiers. The lease lasts five minutes and is renewed by subsequent control commands. It survives the end of a turn so a multi-turn conversation can continue.
3. Use starlite_perform for one atomic gesture and/or bubble. animation must exactly match inspect's catalog. Keep speech concise, plain text, and suitable for a desktop bubble; a gesture without speech is often enough. durationMs is the bubble's 1000–30000 ms lifetime, not an animation-speed control. Each animation plays once. Await completed before choosing the next gesture; interrupted/stopped/rejected means it did not finish. Do not queue a script or flood the desktop with repetitive gestures. stop:true interrupts the current performance.
4. Use starlite_stage sparingly and only for requested presentation changes: position x/y are 0–1 within the current monitor, scale is 0.5–1.5, pointerEnabled temporarily controls cursor following. These changes do not persist. Never move other windows or control the OS.
5. When the user ends role interaction, call starlite_control with action release. On cancellation, model switch, hide, disconnection or expiry, ownership is revoked automatically and normal behavior resumes. Do not reacquire after the user exits unless asked again. Prefer release in a finally block if running a multi-command program.

The user's bubble/privacy choices remain authoritative: user-preference rejects combined speech+animation atomically. If speech is disabled, use animation-only when appropriate, and keep text in the DSH conversation. Pending questions and permission approvals stay in DSH during control. Never impersonate a tool approval, expose private tool results, send messages to external services, or request credentials through a character bubble. No microphone, speech synthesis, screen reading, external messages or paid request is performed by these tools.
`,
};

/** Optional SDK integration: raw JSON-Schema ToolDefinitions avoid eager SDK imports. */
export function registerSessionTools(context: ToolContext, control: SessionControl): () => void {
  const disposers: Array<() => void> = [];
  const output = { schema: { type: "object", additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }] };
  const wrap = (name: string, description: string, properties: object, required: string[], execute: (args: Record<string, unknown>, exec: Execution) => unknown): NativeTool => ({
    name, description, parameters: { type: "object", properties, required, additionalProperties: false }, output, timeoutMs: 40_000,
    async execute(args, execution) {
      const exec = actor(execution), row = record(args);
      if (!row || Object.keys(row).some(key => !(key in properties)) || required.some(key => !(key in row))) throw Error("Invalid StarLite arguments");
      if (exec.signal.aborted) return { status: "interrupted", reason: "cancelled" };
      if (name !== "starlite_inspect" && !control.enabled) return { status: "rejected", reason: "disabled" };
      return execute(row, exec);
    },
  });
  const tools = [
    wrap("starlite_inspect", "Inspect StarLite availability, the current model's exact animation names, preferences and session ownership. Read before acquiring or choosing animations.", {}, [], (_args, exec) => control.inspect(exec.agent.session)),
    wrap("starlite_control", "Acquire, renew or release temporary exclusive control of StarLite for this DSH session. Only use for user-requested character interaction. Release when done.", { action: { type: "string", enum: ["acquire", "renew", "release"] } }, ["action"], (args, exec) => {
      if (args.action === "release") return control.relinquish(exec.agent.session);
      if (args.action !== "acquire" && args.action !== "renew") throw Error("Invalid StarLite action");
      if (args.action === "renew") return control.renewLease(exec.agent.session, sessionTitle(context, exec.agent.session), exec.signal);
      return control.acquire(exec.agent.session, sessionTitle(context, exec.agent.session), exec.signal);
    }),
    wrap("starlite_perform", "During ownership, play one named animation and/or show short plain-text speech atomically. Await actual completion. A new performance replaces the old one. stop:true stops it. Does not override user bubble/privacy settings.", {
      animation: { type: "string", description: "Exact catalog name (1–160 characters)." }, text: { type: "string", description: "Plain text (1–1000 characters)." }, durationMs: { type: "number", description: "Bubble lifetime: 1000–30000 milliseconds; only with text." }, stop: { type: "boolean", const: true },
    }, [], (args, exec) => control.perform(exec.agent.session, args, exec.signal)),
    wrap("starlite_stage", "During ownership, temporarily position or resize the character on its current monitor, or adjust cursor following. All changes revert on release; no OS control.", {
      position: { type: "object", description: "Normalized current-monitor position; both axes must be between 0 and 1.", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
      scale: { type: "number", description: "Temporary model scale: 0.5–1.5." }, pointerEnabled: { type: "boolean" },
    }, [], (args, exec) => control.stage(exec.agent.session, args, exec.signal)),
  ];
  let skillDispose: (() => void) | undefined;
  let failed = false;
  let registrationEpoch = 0;
  const clear = () => {
    registrationEpoch++;
    try { skillDispose?.(); } catch { /* Optional registry may already be disposed. */ } skillDispose = undefined;
    for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* Cordis may already have disposed effects. */ } }
  };
  const sync = () => {
    if (!control.enabled) { clear(); failed = false; return; }
    if (failed) return;
    const registry = service(context, "tools");
    if (typeof registry?.register !== "function") return;
    if (!disposers.length) try {
      // Older official SDKs ignore registration.when. Dynamic registration also
      // keeps disabled tools out of their model catalog and prompts.
      const lookup = registry.get;
      if (typeof lookup === "function" && tools.some(tool => lookup.call(registry, tool.name))) throw Error("tool name already registered");
      const epoch = ++registrationEpoch;
      for (const tool of tools) {
        const definition = { ...tool, execute: (args: unknown, exec: unknown) => epoch === registrationEpoch ? tool.execute(args, exec) : Promise.resolve({ status: "rejected", reason: control.enabled ? "stale" : "disabled" }) };
        const dispose = registry.register.call(registry, definition, { when: (execution: unknown) => {
          try { actor(execution); return epoch === registrationEpoch && control.enabled; } catch { return false; }
        } });
        if (typeof dispose !== "function") throw Error("unsupported tool lifecycle");
        disposers.push(dispose as () => void);
      }
    } catch {
      clear(); failed = true;
      context.logger?.warn?.("StarLite session tools are unavailable in this DSH version; normal companion behavior is unchanged.");
      return;
    }
    if (skillDispose) return;
    const skills = service(context, "skills");
    if (typeof skills?.register !== "function") return;
    try { const dispose = skills.register.call(skills, skill); if (typeof dispose === "function") skillDispose = dispose as () => void; } catch { /* Skill support is optional; native tools still work. */ }
  };
  const unsubscribe = control.onChange(sync); sync();
  return () => { unsubscribe(); clear(); };
}
function actor(value: unknown): Execution {
  const row = record(value), agent = record(row?.agent), signal = row?.signal as AbortSignal | undefined;
  if (!agent || agent.session === undefined || agent.session === null || !signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") throw Error("StarLite requires a live DSH execution session");
  return { agent: { session: agent.session }, signal };
}
function sessionTitle(context: ToolContext, session: unknown): unknown {
  const titles = service(context, "sessionTitle");
  try { return typeof titles?.get === "function" ? record(titles.get.call(titles, session))?.title : undefined; } catch { return undefined; }
}
function service(context: ToolContext, name: string): Record<string, unknown> | undefined { try { return record(context.get?.(name)); } catch { return undefined; } }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
