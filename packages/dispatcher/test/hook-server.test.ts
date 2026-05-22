import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HookServer } from "../src/hook-server.ts";

let server: HookServer;

beforeEach(() => {
  server = new HookServer();
  server.start(0); // ephemeral port
});

afterEach(() => {
  server.stop();
});

async function postHook(
  event: string,
  sessionName: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/hooks/${event}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Middle-Session": sessionName },
    body: JSON.stringify(payload),
  });
}

describe("HookServer — SessionStart", () => {
  test("awaitSessionStart resolves with the posted payload", async () => {
    const pending = server.awaitSessionStart("middle-6", 1000);
    const res = await postHook("session.started", "middle-6", {
      session_id: "sess-abc",
      transcript_path: "/home/u/.claude/projects/x/sess-abc.jsonl",
    });
    expect(res.status).toBe(200);
    const payload = await pending;
    expect(payload.session_id).toBe("sess-abc");
    expect(payload.transcript_path).toBe("/home/u/.claude/projects/x/sess-abc.jsonl");
  });

  test("a payload that arrives before anyone awaits is stashed and delivered", async () => {
    await postHook("session.started", "middle-7", { session_id: "early" });
    const payload = await server.awaitSessionStart("middle-7", 1000);
    expect(payload.session_id).toBe("early");
  });

  test("duplicate pre-await arrivals keep the FIRST payload, not the last", async () => {
    // a retry scenario could fire SessionStart twice with overlapping payloads;
    // the second must not silently overwrite the first
    await postHook("session.started", "middle-9", { session_id: "first" });
    await postHook("session.started", "middle-9", { session_id: "second" });
    const payload = await server.awaitSessionStart("middle-9", 1000);
    expect(payload.session_id).toBe("first");
  });

  test("waiters are keyed by session — one session's event does not satisfy another", async () => {
    const pending = server.awaitSessionStart("middle-8", 300);
    await postHook("session.started", "middle-DIFFERENT", { session_id: "x" });
    await expect(pending).rejects.toThrow();
  });
});

describe("HookServer — Stop", () => {
  test("awaitStop resolves on an agent.stopped POST", async () => {
    const pending = server.awaitStop("middle-6", 1000);
    await postHook("agent.stopped", "middle-6", { reason: "turn-end" });
    const payload = await pending;
    expect(payload.reason).toBe("turn-end");
  });
});

describe("HookServer — lifecycle", () => {
  test("awaitSessionStart rejects on timeout", async () => {
    await expect(server.awaitSessionStart("never", 50)).rejects.toThrow();
  });

  test("non-POST and unknown paths return 404", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
  });

  test("stop() rejects outstanding waiters", async () => {
    const pending = server.awaitStop("middle-6", 5000);
    server.stop();
    await expect(pending).rejects.toThrow();
  });
});
