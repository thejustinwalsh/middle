import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookPayload, NormalizedEvent } from "@middle/core";
import { HookServer } from "../src/hook-server.ts";
import type { HookStore } from "../src/hook-store.ts";

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

describe("HookServer — HMAC auth + event validation (with store)", () => {
  /** A store that knows one session/token and records every accepted hook. */
  function makeStore(sessionName: string, token: string) {
    const recorded: Array<{ event: NormalizedEvent; sessionName: string; payload: HookPayload }> =
      [];
    const store: HookStore = {
      resolveSessionToken: (name) => (name === sessionName ? token : null),
      record: (event, name, payload) => recorded.push({ event, sessionName: name, payload }),
    };
    return { store, recorded };
  }

  let authServer: HookServer;
  let recorded: Array<{ event: NormalizedEvent; sessionName: string; payload: HookPayload }>;

  beforeEach(() => {
    const made = makeStore("middle-42", "good-token");
    recorded = made.recorded;
    authServer = new HookServer(made.store);
    authServer.start(0);
  });

  afterEach(() => {
    authServer.stop();
  });

  function authPost(
    event: string,
    headers: Record<string, string>,
    payload: Record<string, unknown> = {},
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${authServer.port}/hooks/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  }

  test("a valid POST (correct token, known event) is accepted and recorded", async () => {
    const res = await authPost(
      "tool.pre",
      { "X-Middle-Session": "middle-42", "X-Middle-Token": "good-token" },
      { tool: "Bash" },
    );
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.event).toBe("tool.pre");
    expect(recorded[0]!.sessionName).toBe("middle-42");
  });

  test("a bad-HMAC POST is rejected 401 and never recorded", async () => {
    const res = await authPost("tool.pre", {
      "X-Middle-Session": "middle-42",
      "X-Middle-Token": "wrong-token",
    });
    expect(res.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  test("a POST for an unknown session is rejected 401 (no token resolvable)", async () => {
    const res = await authPost("tool.pre", {
      "X-Middle-Session": "middle-DOES-NOT-EXIST",
      "X-Middle-Token": "good-token",
    });
    expect(res.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  test("an unknown event name is rejected 400 before auth or recording", async () => {
    const res = await authPost("not.a.real.event", {
      "X-Middle-Session": "middle-42",
      "X-Middle-Token": "good-token",
    });
    expect(res.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });

  test("session.started with a valid token resolves the SessionGate awaiter", async () => {
    const pending = authServer.awaitSessionStart("middle-42", 1000);
    const res = await authPost(
      "session.started",
      { "X-Middle-Session": "middle-42", "X-Middle-Token": "good-token" },
      { session_id: "s1", transcript_path: "/t/s1.jsonl" },
    );
    expect(res.status).toBe(200);
    const payload = await pending;
    expect(payload.session_id).toBe("s1");
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
