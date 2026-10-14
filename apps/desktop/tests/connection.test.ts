import { describe, expect, it, vi } from "vitest";
import { StatusConnection, consumeSseFrames } from "../src/connection.js";

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
});
