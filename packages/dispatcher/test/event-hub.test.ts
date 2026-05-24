import { describe, expect, test } from "bun:test";
import { EventHub, type Event } from "../src/event-hub.ts";

// The EventHub is the control plane's broadcast fan-out: `mm dispatch` (and
// later the dashboard) subscribe to a live SSE stream of workflow state. These
// tests pin the connection lifecycle — connected frame, init-replay, live
// broadcast, heartbeat, and clean drop on abort / slow-consumer overflow —
// in isolation from any engine.

/** Read SSE frames off a Response body until `count` blank-line-terminated frames arrive. */
async function readFrames(res: Response, count: number, deadlineMs = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const deadline = Date.now() + deadlineMs;
  try {
    while (frames.length < count && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (result === "timeout" || result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        frames.push(buffer.slice(0, idx + 2));
        buffer = buffer.slice(idx + 2);
        if (frames.length >= count) break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return frames;
}

function eventsRequest(signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/control/events", signal ? { signal } : {});
}

describe("EventHub", () => {
  test("serve emits a `connected` frame first, with SSE content-type", async () => {
    const hub = new EventHub();
    const res = hub.serve(eventsRequest());
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const [first] = await readFrames(res, 1);
    expect(first).toContain("event: connected");
  });

  test("serve replays caller-supplied init events after `connected`", async () => {
    const hub = new EventHub();
    const init: Event[] = [
      { type: "workflow", data: { id: "wf-1", repo: "o/r", epic: 5, state: "running" } },
    ];
    const res = hub.serve(eventsRequest(), init);
    const [connected, replay] = await readFrames(res, 2);
    expect(connected).toContain("event: connected");
    expect(replay).toContain("event: workflow");
    expect(replay).toContain('"id":"wf-1"');
    expect(replay).toContain('"state":"running"');
  });

  test("a broadcast reaches a live subscriber", async () => {
    const hub = new EventHub();
    const res = hub.serve(eventsRequest());
    await readFrames(res, 1); // drain `connected`
    hub.broadcast({
      type: "workflow",
      data: { id: "wf-2", repo: "o/r", epic: 9, state: "waiting" },
    });
    const [frame] = await readFrames(res, 1);
    expect(frame).toContain("event: workflow");
    expect(frame).toContain('"id":"wf-2"');
    expect(frame).toContain('"state":"waiting"');
  });

  test("a heartbeat keeps the stream alive (injectable interval)", async () => {
    const hub = new EventHub({ heartbeatMs: 20 });
    const res = hub.serve(eventsRequest());
    await readFrames(res, 1); // drain `connected`
    const [hb] = await readFrames(res, 1);
    expect(hb).toContain(": heartbeat");
  });

  test("an aborted client is unsubscribed cleanly", async () => {
    const hub = new EventHub();
    const ac = new AbortController();
    const res = hub.serve(eventsRequest(ac.signal));
    await readFrames(res, 1); // connect
    expect(hub.subscriberCount()).toBe(1);
    ac.abort();
    await Bun.sleep(10);
    expect(hub.subscriberCount()).toBe(0);
  });

  test("a slow consumer that overflows its buffer is dropped without throwing", async () => {
    const hub = new EventHub({ maxBuffer: 4 });
    // Never read the body → its buffer fills.
    const res = hub.serve(eventsRequest());
    expect(hub.subscriberCount()).toBe(1);
    // Far more than maxBuffer broadcasts: the subscriber must be dropped, not throw.
    for (let i = 0; i < 50; i++) {
      hub.broadcast({
        type: "workflow",
        data: { id: `wf-${i}`, repo: "o/r", epic: 1, state: "running" },
      });
    }
    expect(hub.subscriberCount()).toBe(0);
    // The stream is still a valid (closed) Response; cancel to release it.
    await res.body!.cancel();
  });
});
