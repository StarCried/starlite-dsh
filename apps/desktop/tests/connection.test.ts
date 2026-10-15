import { describe, expect, it, vi } from "vitest";
import { StatusConnection, consumeSseFrames } from "../src/connection.js";
import { StateAnimator } from "../src/state-animator.js";
import type { PetState, WidgetController } from "../src/vendor-types.js";

const CONNECTION_URL =
  "dsh-inochi2d-pet://connect?port=45678" +
  "&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
  "&instance=123e4567-e89b-42d3-a456-426614174000";

describe("consumeSseFrames", () => {
  it("extracts only complete snapshot events and keeps the partial tail", () => {
    const result = consumeSseFrames(
      ": heartbeat\n\n" +
      "id: 1\nevent: snapshot\ndata: {\"state\":\"idle\"}\n\n" +
      "event: ignored\ndata: secret\n\n" +
      "event: snap",
    );
    expect(result.data).toEqual(['{"state":"idle"}']);
    expect(result.rest).toBe("event: snap");
  });

  it("supports CRLF and multi-line data", () => {
    expect(consumeSseFrames("event: snapshot\r\ndata: one\r\ndata: two\r\n\r\n").data)
      .toEqual(["one\ntwo"]);
  });

  it("invokes browser fetch without binding the controller as this", async () => {
    let receiver: unknown = "not called";
    const snapshots: number[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: snapshot\ndata: {"protocolVersion":1,"sequence":4,"emittedAt":1,"state":"idle"}\n\n' +
          'event: snapshot\ndata: {"protocolVersion":1,"sequence":4,"emittedAt":2,"state":"thinking"}\n\n' +
          'event: snapshot\ndata: {"protocolVersion":1,"sequence":3,"emittedAt":3,"state":"error"}\n\n' +
          'event: snapshot\ndata: {"protocolVersion":1,"sequence":5,"emittedAt":4,"state":"completed"}\n\n',
        ));
      },
    });
    const fetchImplementation = function (this: unknown) {
      // oxlint-disable-next-line typescript/no-this-alias -- detect accidental binding of native fetch.
      receiver = this;
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }));
    } as typeof fetch;
    const connection = new StatusConnection({
      onConnected() {},
      onDisconnected() {},
      onSnapshot(snapshot) {
        snapshots.push(snapshot.sequence);
      },
    }, fetchImplementation);

    connection.connect(CONNECTION_URL);
    await vi.waitFor(() => expect(snapshots).toEqual([4, 5]));
    expect(receiver).toBeUndefined();
    connection.stop();
  });
});

describe("same Host stream resynchronization", () => {
  function fixture(onSnapshot = vi.fn(), onDisconnected = vi.fn()) {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { streams.push(stream); },
    }), {headers: {"Content-Type": "text/event-stream"}}));
    const callbacks = {onConnected: vi.fn(), onSnapshot, onDisconnected};
    const connection = new StatusConnection(callbacks, request);
    const frame = (stream: number, sequence: number, state: PetState = "idle") => {
      streams[stream]!.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({protocolVersion: 1, sequence, emittedAt: sequence, state})}\n\n`));
    };
    const reconnect = async (stream: number) => {
      streams[stream]!.error(Error("transient stream interruption"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      expect(streams).toHaveLength(stream + 2);
    };
    return {connection, callbacks, frame, reconnect, streams};
  }

  it("restores clicking from unchanged Idle after repeated transient disconnects", async () => {
    vi.useFakeTimers();
    const playAnimation = vi.fn<WidgetController["playAnimation"]>(async () => "completed");
    const animator = new StateAnimator({playAnimation, stopAnimation: vi.fn()} as unknown as WidgetController, {
      idle: "Idle", working: null, completed: null, error: null, blocked: null, approval: null, click: ["Click"], ambient: [],
    });
    const test = fixture(vi.fn(snapshot => animator.apply(snapshot)), vi.fn(() => animator.disconnected()));
    try {
      test.connection.connect(CONNECTION_URL);
      await vi.advanceTimersByTimeAsync(0);
      test.frame(0, 4);
      await vi.advanceTimersByTimeAsync(0);
      await animator.click();
      expect(playAnimation.mock.calls.filter(([name]) => name === "Click")).toHaveLength(1);
      for (let stream = 0; stream < 2; stream += 1) {
        await test.reconnect(stream);
        await animator.click();
        expect(playAnimation.mock.calls.filter(([name]) => name === "Click")).toHaveLength(stream + 1);
        test.frame(stream + 1, 4);
        await vi.advanceTimersByTimeAsync(0);
        await animator.click();
        expect(playAnimation.mock.calls.filter(([name]) => name === "Click")).toHaveLength(stream + 2);
      }
      expect(test.callbacks.onConnected).toHaveBeenCalledTimes(3);
      expect(test.callbacks.onSnapshot.mock.calls.map(([snapshot]) => snapshot.sequence)).toEqual([4, 4, 4]);
    } finally { test.connection.stop(); animator.disconnected(); vi.useRealTimers(); }
  });

  it("ignores stale first frames and later duplicates without losing the initial equal snapshot", async () => {
    vi.useFakeTimers();
    const test = fixture();
    try {
      test.connection.connect(CONNECTION_URL);
      await vi.advanceTimersByTimeAsync(0);
      test.frame(0, 4);
      await vi.advanceTimersByTimeAsync(0);
      await test.reconnect(0);
      test.streams[1]!.enqueue(new TextEncoder().encode(": heartbeat\n\nevent: ignored\ndata: ignored\n\n"));
      test.frame(1, 3, "error");
      test.frame(1, 4);
      test.frame(1, 4, "error");
      await vi.advanceTimersByTimeAsync(0);
      test.frame(1, 4, "error");
      test.frame(1, 5, "working");
      test.frame(1, 4, "error");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.callbacks.onSnapshot.mock.calls.map(([snapshot]) => [snapshot.sequence, snapshot.state]))
        .toEqual([[4, "idle"], [4, "idle"], [5, "working"]]);
      await test.reconnect(1);
      test.frame(2, 6, "completed");
      test.frame(2, 5, "error");
      test.frame(2, 6, "error");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.callbacks.onSnapshot.mock.calls.map(([snapshot]) => [snapshot.sequence, snapshot.state]))
        .toEqual([[4, "idle"], [4, "idle"], [5, "working"], [6, "completed"]]);
    } finally { test.connection.stop(); vi.useRealTimers(); }
  });
});

describe("single Host ownership",()=>{
  const other=CONNECTION_URL.replace("174000","174001");
  function fixture(){
    let stream!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(controller){stream=controller;}});
    const request=vi.fn<typeof fetch>(async()=>new Response(body,{headers:{"Content-Type":"text/event-stream"}}));
    const callbacks={onSnapshot:vi.fn(),onConnected:vi.fn(),onDisconnected:vi.fn(),onConflict:vi.fn()};
    const connection=new StatusConnection(callbacks,request);
    const frame=(sequence:number)=>stream.enqueue(new TextEncoder().encode(`event: snapshot\ndata: {"protocolVersion":1,"sequence":${sequence},"emittedAt":1,"state":"working","bubble":{"kind":"response","text":"Original Host"}}\n\n`));
    return {connection,callbacks,request,frame,get stream(){return stream;}};
  }

  it("treats an identical descriptor as an idempotent launch without interrupting snapshots",async()=>{
    const test=fixture();
    expect(test.connection.connect(CONNECTION_URL)).toBe("accepted");
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    try{
      expect(test.connection.connect(CONNECTION_URL)).toBe("unchanged");
      test.frame(1);await vi.waitFor(()=>expect(test.callbacks.onSnapshot).toHaveBeenCalledOnce());
      expect(test.request).toHaveBeenCalledOnce();expect(test.request.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      expect(test.callbacks.onDisconnected).not.toHaveBeenCalled();expect(test.callbacks.onConflict).not.toHaveBeenCalled();
    }finally{test.connection.stop();}
  });

  it.each([other,CONNECTION_URL.replace("45678","45679"),CONNECTION_URL.replace("token=a","token=b")])("refuses a different descriptor while retaining the current stream: %s",async incoming=>{
    const test=fixture();test.connection.connect(CONNECTION_URL);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    try{
      test.frame(1);await vi.waitFor(()=>expect(test.callbacks.onSnapshot).toHaveBeenCalledOnce());
      expect(test.connection.connect(incoming)).toBe("conflict");
      expect(test.connection.connect(other)).toBe("conflict");
      expect(test.callbacks.onConflict).toHaveBeenCalledOnce();expect(test.callbacks.onDisconnected).not.toHaveBeenCalled();
      test.frame(2);await vi.waitFor(()=>expect(test.callbacks.onSnapshot).toHaveBeenCalledTimes(2));
      expect(test.callbacks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({sequence:2,state:"working",bubble:{text:"Original Host"}});
      expect(test.request).toHaveBeenCalledOnce();expect(test.request.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    }finally{test.connection.stop();}
  });

  it("keeps ownership across a transient disconnect and releases it only when stopped",async()=>{
    const test=fixture();test.connection.connect(CONNECTION_URL);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    try{
      test.stream.error(Error("temporary disconnection"));
      await vi.waitFor(()=>expect(test.callbacks.onDisconnected).toHaveBeenCalledOnce());
      expect(test.connection.connect(other)).toBe("conflict");expect(test.callbacks.onConflict).toHaveBeenCalledOnce();
      expect(test.connection.connect(CONNECTION_URL)).toBe("unchanged");
      test.connection.stop();
      test.request.mockImplementation(async()=>new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}}));
      expect(test.connection.connect(other)).toBe("accepted");
      await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledTimes(2));
      expect(test.request.mock.calls.at(-1)![1]).toMatchObject({headers:{Authorization:`Bearer ${"a".repeat(43)}`}});
    }finally{test.connection.stop();}
  });

  it("queues only the first valid successor, never takes a live Host, and preserves the queue for duplicate launches",async()=>{
    const test=fixture(); test.connection.connect(CONNECTION_URL);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    const first=other.replace("45678","45679"),later=other.replace("45678","45680");
    try {
      expect(()=>test.connection.connect("dsh-inochi2d-pet://connect?invalid=1")).toThrow();
      test.connection.connect(first); test.connection.connect(later);
      expect(test.connection.connect(CONNECTION_URL)).toBe("unchanged");
      expect(test.connection.connectPending()).toBe(false);
      expect(test.request).toHaveBeenCalledOnce();
      test.stream.error(Error("original Host stopped"));
      await vi.waitFor(()=>expect(test.callbacks.onDisconnected).toHaveBeenCalledOnce());
      test.request.mockImplementation(async()=>new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}}));
      expect(test.connection.connectPending()).toBe(true);
      await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledTimes(2));
      expect(test.request.mock.calls.at(-1)![0]).toBe("http://127.0.0.1:45679/v1/events");
      expect(test.connection.connectPending()).toBe(false);
    } finally {test.connection.stop();}
  });

  it("clears a queued credential on stop instead of retaining it for a later manual connection",async()=>{
    const test=fixture();test.connection.connect(CONNECTION_URL);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    test.connection.connect(other);test.connection.stop();
    expect(test.connection.connectPending()).toBe(false);
  });

  it("does not accept late headers from a superseded Host",async()=>{
    let finishOld!: (response: Response)=>void;
    const old = new Promise<Response>(resolve=>{finishOld=resolve;});
    const request=vi.fn<typeof fetch>().mockImplementationOnce(()=>old).mockImplementation(async()=>new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}}));
    const callbacks={onSnapshot:vi.fn(),onConnected:vi.fn(),onDisconnected:vi.fn()};
    const connection=new StatusConnection(callbacks,request);
    connection.connect(CONNECTION_URL); connection.connect(other); expect(connection.connectPending()).toBe(true);
    await vi.waitFor(()=>expect(callbacks.onConnected).toHaveBeenCalledOnce());
    finishOld(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"protocolVersion":1,"sequence":1,"emittedAt":1,"state":"error"}\n\n'));}}),{headers:{"Content-Type":"text/event-stream"}}));
    await Promise.resolve();await Promise.resolve();
    expect(callbacks.onConnected).toHaveBeenCalledOnce();expect(callbacks.onSnapshot).not.toHaveBeenCalled();connection.stop();
  });

  it("does not publish a queued old frame after stop and a new connection",async()=>{
    const test=fixture();test.connection.connect(CONNECTION_URL);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledOnce());
    test.frame(1); test.connection.stop();
    test.request.mockImplementation(async()=>new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}}));
    test.connection.connect(other);
    await vi.waitFor(()=>expect(test.callbacks.onConnected).toHaveBeenCalledTimes(2));
    expect(test.callbacks.onSnapshot).not.toHaveBeenCalled();test.connection.stop();
  });
});
