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
