import {
  MAX_WIRE_BYTES,
  parsePetConnectionUrl,
  parsePetSnapshotJson,
  type PetConnectionDescriptor,
  type PetSnapshot,
} from "@dsh-inochi2d-pet/protocol";

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
const MAX_SSE_TAIL_BYTES = MAX_WIRE_BYTES * 4;

export interface ConnectionCallbacks {
  onSnapshot(snapshot: PetSnapshot): void;
  onConnected(): void;
  onDisconnected(): void;
}

export interface ConnectionTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemTimers: ConnectionTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Fetch-based SSE is used because browser EventSource cannot send bearer auth. */
export class StatusConnection {
  readonly #callbacks: ConnectionCallbacks;
  readonly #fetch: typeof fetch;
  readonly #timers: ConnectionTimers;
  #descriptor: PetConnectionDescriptor | undefined;
  #abort: AbortController | undefined;
  #run = 0;
  #lastSequence = -1;

  constructor(
    callbacks: ConnectionCallbacks,
    fetchImplementation: typeof fetch = fetch,
    timers: ConnectionTimers = systemTimers,
  ) {
    this.#callbacks = callbacks;
    this.#fetch = fetchImplementation;
    this.#timers = timers;
  }

  connect(rawUrl: string): void {
    const descriptor = parsePetConnectionUrl(rawUrl);
    this.stop();
    this.#descriptor = descriptor;
    this.#lastSequence = -1;
    const run = ++this.#run;
    void this.#connectionLoop(descriptor, run);
  }

  stop(): void {
    this.#run += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#descriptor = undefined;
  }

  async #connectionLoop(descriptor: PetConnectionDescriptor, run: number): Promise<void> {
    let attempt = 0;
    let wasConnected = false;
    while (run === this.#run && this.#descriptor === descriptor) {
      const abort = new AbortController();
      this.#abort = abort;
      try {
        await this.#readOnce(descriptor, abort, () => {
          attempt = 0;
          if (!wasConnected) {
            wasConnected = true;
            this.#callbacks.onConnected();
          }
        });
      } catch {
        // Disconnection details can contain addresses and platform errors; they
        // are intentionally not logged or sent back to DSH.
      }
      if (run !== this.#run || this.#descriptor !== descriptor) return;
      if (wasConnected) {
        wasConnected = false;
        this.#callbacks.onDisconnected();
      }
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 250 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      await wait(delay, this.#timers, abort.signal);
    }
  }

  async #readOnce(
    descriptor: PetConnectionDescriptor,
    abort: AbortController,
    onOpen: () => void,
  ): Promise<void> {
    const endpoint = `http://127.0.0.1:${descriptor.port}/v1/events`;
    // Calling a browser native as a private-field method binds `this` to the
    // StatusConnection instance and fails with "Illegal invocation" in
    // WebView2. Copy it to a local before invoking it.
    const request = this.#fetch;
    const response = await request(endpoint, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      signal: abort.signal,
    });
    if (
      !response.ok
      || !response.body
      || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
    ) {
      throw new Error("status stream unavailable");
    }
    onOpen();

    let buffer = "";
    let heartbeat = this.#armHeartbeat(abort);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#timers.clearTimeout(heartbeat);
        heartbeat = this.#armHeartbeat(abort);
        buffer += decoder.decode(value, { stream: true });
        const parsed = consumeSseFrames(buffer);
        buffer = parsed.rest;
        if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_TAIL_BYTES) {
          throw new Error("status stream frame exceeds the buffer limit");
        }
        for (const data of parsed.data) {
          const snapshot = parsePetSnapshotJson(data);
          if (snapshot.sequence <= this.#lastSequence) continue;
          this.#lastSequence = snapshot.sequence;
          this.#callbacks.onSnapshot(snapshot);
        }
      }
      throw new Error("status stream ended");
    } finally {
      this.#timers.clearTimeout(heartbeat);
      reader.releaseLock();
    }
  }

  #armHeartbeat(abort: AbortController): ReturnType<typeof setTimeout> {
    return this.#timers.setTimeout(() => abort.abort(), HEARTBEAT_TIMEOUT_MS);
  }
}

export function consumeSseFrames(input: string): { data: string[]; rest: string } {
  const normalized = input.replace(/\r\n/gu, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const data: string[] = [];
  for (const frame of frames) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trimStart();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (event === "snapshot" && dataLines.length > 0) data.push(dataLines.join("\n"));
  }
  return { data, rest };
}

function wait(delayMs: number, timers: ConnectionTimers, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = timers.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      timers.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
