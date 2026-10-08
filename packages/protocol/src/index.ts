export const PET_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BUBBLE_GRAPHEMES = 120;
export const MAX_WIRE_BYTES = 4_096;
const MAX_SANITIZE_CODE_UNITS = 16_384;

export const PET_STATES = [
  "idle",
  "thinking",
  "working",
  "completed",
  "error",
  "blocked",
  "approval",
] as const;

export type PetState = (typeof PET_STATES)[number];

export const BUBBLE_KINDS = [
  "reasoning",
  "response",
  "tool",
  "notice",
] as const;

export type BubbleKind = (typeof BUBBLE_KINDS)[number];

export interface PetBubble {
  kind: BubbleKind;
  text: string;
}

export interface PetSnapshot {
  protocolVersion: typeof PET_PROTOCOL_VERSION;
  sequence: number;
  emittedAt: number;
  state: PetState;
  bubble?: PetBubble;
}

export interface PetStateSource {
  start(emit: (snapshot: PetSnapshot) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface PetConnectionDescriptor {
  readonly port: number;
  readonly token: string;
  readonly instanceId: string;
}

/** Strictly validates the one deep-link shape emitted by the WSL bridge. */
export function parsePetConnectionUrl(rawUrl: string): PetConnectionDescriptor {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("pet connection URL is invalid");
  }
  if (
    url.protocol !== "dsh-inochi2d-pet:" ||
    url.hostname !== "connect" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("pet connection URL target is invalid");
  }
  const allowed = new Set(["port", "token", "instance"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error("pet connection URL contains unknown fields");
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new Error(`pet connection URL field ${key} must occur once`);
    }
  }
  const portText = url.searchParams.get("port") ?? "";
  const port = Number(portText);
  const token = url.searchParams.get("token") ?? "";
  const instanceId = url.searchParams.get("instance") ?? "";
  if (!/^[1-9]\d{0,4}$/.test(portText) || !Number.isInteger(port) || port > 65_535) {
    throw new Error("pet connection port is invalid");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("pet connection token is invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(instanceId)) {
    throw new Error("pet connection instance is invalid");
  }
  return { port, token, instanceId };
}

/**
 * Reduces untrusted model-visible content to short, single-line plain text.
 * This function is deliberately shared by both sides of the WSL boundary.
 */
export function sanitizeBubbleText(
  input: unknown,
  maximumGraphemes = DEFAULT_BUBBLE_GRAPHEMES,
): string {
  if (typeof input !== "string" || !Number.isSafeInteger(maximumGraphemes)) {
    return "";
  }
  if (maximumGraphemes < 1 || maximumGraphemes > 500) {
    return "";
  }
  // DSH-visible output can still be very large. Bound work before Unicode
  // normalization/segmentation, while keeping far more context than the 500
  // grapheme public maximum.
  const bounded = input.length > MAX_SANITIZE_CODE_UNITS
    ? input.slice(0, MAX_SANITIZE_CODE_UNITS)
    : input;
  const normalized = bounded
    .normalize("NFC")
    // These ranges intentionally strip terminal and C0/C1 control bytes.
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?|[@-_])/gu, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) {
    return "";
  }
  const graphemes = segmentGraphemes(normalized);
  const truncated = graphemes.length > maximumGraphemes || input.length > MAX_SANITIZE_CODE_UNITS;
  return truncated
    ? `${graphemes.slice(0, maximumGraphemes - 1).join("")}…`
    : normalized;
}

export function parsePetSnapshot(value: unknown): PetSnapshot {
  if (!isRecord(value)) {
    throw new Error("pet snapshot must be an object");
  }
  if (value.protocolVersion !== PET_PROTOCOL_VERSION) {
    throw new Error("unsupported pet protocol version");
  }
  if (!isNonNegativeSafeInteger(value.sequence)) {
    throw new Error("pet snapshot sequence is invalid");
  }
  if (!isFiniteTimestamp(value.emittedAt)) {
    throw new Error("pet snapshot timestamp is invalid");
  }
  if (!isPetState(value.state)) {
    throw new Error("pet snapshot state is invalid");
  }
  const bubble = value.bubble === undefined ? undefined : parseBubble(value.bubble);
  return {
    protocolVersion: PET_PROTOCOL_VERSION,
    sequence: value.sequence,
    emittedAt: value.emittedAt,
    state: value.state,
    ...(bubble ? { bubble } : {}),
  };
}

export function parsePetSnapshotJson(json: string): PetSnapshot {
  if (new TextEncoder().encode(json).byteLength > MAX_WIRE_BYTES) {
    throw new Error("pet snapshot exceeds the wire limit");
  }
  return parsePetSnapshot(JSON.parse(json) as unknown);
}

export function isPetState(value: unknown): value is PetState {
  return typeof value === "string" && (PET_STATES as readonly string[]).includes(value);
}

function parseBubble(value: unknown): PetBubble {
  if (!isRecord(value) || !isBubbleKind(value.kind)) {
    throw new Error("pet snapshot bubble is invalid");
  }
  const text = sanitizeBubbleText(value.text);
  if (text.length === 0) {
    throw new Error("pet snapshot bubble text is empty or invalid");
  }
  return { kind: value.kind, text };
}

function isBubbleKind(value: unknown): value is BubbleKind {
  return (
    typeof value === "string" &&
    (BUBBLE_KINDS as readonly string[]).includes(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segmentGraphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map(({ segment }) => segment);
  }
  return Array.from(value);
}
