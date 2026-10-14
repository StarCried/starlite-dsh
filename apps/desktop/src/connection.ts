import {
  MAX_WIRE_BYTES,
  parsePetConnectionUrl,
  parsePetSnapshotJson,
  parseBillingSnapshot,
  type BillingSnapshot,
  type PetConnectionDescriptor,
  type PetSnapshot,
  MAX_INTERACTION_BYTES,parsePetInteraction,parsePetAnswer,isOpaqueRef,
  type PetInteraction,type PetAnswer,
} from "@starcried/starlite-dsh-protocol";

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
const MAX_SSE_TAIL_BYTES = MAX_WIRE_BYTES * 4;

export interface ConnectionCallbacks {
  onSnapshot(snapshot: PetSnapshot): void;
  onConnected(): void;
  onDisconnected(): void;
  onConflict?(): void;
}

export type ConnectionAdmission = "accepted" | "unchanged" | "conflict";

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
  #pendingDescriptor: PetConnectionDescriptor | undefined;
  #abort: AbortController | undefined;
  readonly #requests = new Set<AbortController>();
  #connected = false;
  #run = 0;
  #lastSequence = -1;
  #conflictReported = false;

  constructor(
    callbacks: ConnectionCallbacks,
    fetchImplementation: typeof fetch = fetch,
    timers: ConnectionTimers = systemTimers,
  ) {
    this.#callbacks = callbacks;
    this.#fetch = fetchImplementation;
    this.#timers = timers;
  }

  connect(rawUrl: string): ConnectionAdmission {
    const descriptor = parsePetConnectionUrl(rawUrl);
    if (this.#descriptor) {
      const current = this.#descriptor;
      if (current.instanceId === descriptor.instanceId && current.port === descriptor.port && current.token === descriptor.token) return "unchanged";
      // A transient disconnection does not release this Host's ownership.
      // Retain only the first successor, without changing the current lease.
      this.#pendingDescriptor ??= descriptor;
      if (!this.#conflictReported) {
        this.#conflictReported = true;
        this.#callbacks.onConflict?.();
      }
      return "conflict";
    }
    this.#start(descriptor);
    return "accepted";
  }

  /** Called only when the original Host's offline lease has expired. */
  connectPending(): boolean {
    if (this.#connected || !this.#pendingDescriptor) return false;
    const descriptor = this.#pendingDescriptor;
    this.#start(descriptor);
    return true;
  }

  #start(descriptor: PetConnectionDescriptor): void {
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
    this.#pendingDescriptor = undefined;
    this.#connected = false;
    this.#conflictReported = false;
    this.#cancelRequests();
  }

  async readBilling(): Promise<BillingSnapshot> {
    return parseBillingSnapshot(await this.#request("/v1/billing",MAX_WIRE_BYTES));
  }
  async readInteraction(id:string):Promise<PetInteraction>{
    if(!isOpaqueRef(id))throw Error("invalid question reference");
    const result=parsePetInteraction(await this.#request(`/v1/interaction?request=${id}`,MAX_INTERACTION_BYTES));
    if(result.requestId!==id)throw Error("question changed");return result;
  }
  async answerInteraction(answer:PetAnswer):Promise<void>{await this.#request("/v1/interaction/answer",MAX_INTERACTION_BYTES,parsePetAnswer(answer));}
  async setInputAvailable(enabled:boolean):Promise<void>{await this.#request("/v1/interaction/availability",MAX_INTERACTION_BYTES,{enabled});}
  async openSession(sessionRef:string):Promise<void>{
    if(!isOpaqueRef(sessionRef))throw Error("invalid session reference");
    await this.#request("/v1/session/open",MAX_INTERACTION_BYTES,{sessionRef});
  }
  async openWebUi():Promise<void>{
    await this.#request("/v1/web/open",MAX_INTERACTION_BYTES,{});
  }
  #cancelRequests():void{for(const abort of this.#requests)abort.abort();this.#requests.clear();}
  async #request(path:string,limit:number,body?:unknown):Promise<unknown>{
    const descriptor = this.#descriptor;
    if (!descriptor || !this.#connected) throw new Error("companion disconnected");
    const abort = new AbortController(); this.#requests.add(abort);
    const timer = this.#timers.setTimeout(() => abort.abort(), 10_000);
    const request = this.#fetch;
    try {
      const jsonBody=body===undefined?undefined:JSON.stringify(body);
      if(jsonBody && new TextEncoder().encode(jsonBody).length>limit)throw Error("action too large");
      const response = await request(`http://127.0.0.1:${descriptor.port}${path}`, {
        cache: "no-store", headers: {Authorization: `Bearer ${descriptor.token}`,...(jsonBody?{"Content-Type":"application/json"}:{})}, signal: abort.signal,
        ...(jsonBody?{method:"POST",body:jsonBody}:{}),
      });
      if(jsonBody){await response.body?.cancel();if(!response.ok||descriptor!==this.#descriptor||abort.signal.aborted)throw Error("action unavailable");return undefined;}
      if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        await response.body?.cancel(); throw new Error("billing unavailable");
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let json = ""; let bytes = 0;
      try {
        while (true) {
          const {done,value} = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > limit) throw new Error("response too large");
          json += decoder.decode(value,{stream:true});
        }
        json += decoder.decode();
      } finally {await reader.cancel().catch(() => undefined);}
      if (descriptor !== this.#descriptor || abort.signal.aborted) throw new Error("billing disconnected");
      return JSON.parse(json) as unknown;
    } finally {this.#timers.clearTimeout(timer); this.#requests.delete(abort);}
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
            this.#connected = true;
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
        this.#connected = false;
        this.#cancelRequests();
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
    if (abort.signal.aborted || this.#descriptor !== descriptor) {
      await response.body?.cancel();
      throw new Error("status connection superseded");
    }
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
        if (abort.signal.aborted || this.#descriptor !== descriptor) throw new Error("status connection superseded");
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
      await reader.cancel().catch(() => undefined);
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
