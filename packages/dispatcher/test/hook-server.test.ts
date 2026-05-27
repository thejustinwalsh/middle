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

  test("a subagent stop does NOT resolve awaitStop — only the main agent's Stop does", async () => {
    // Regression: SubagentStop normalizes to agent.subagent-stopped, not
    // agent.stopped. A spawned Explore agent finishing must not be mistaken for
    // the main agent's turn boundary (which tore the workflow down mid-research).
    const pending = server.awaitStop("middle-6", 300);
    await postHook("agent.subagent-stopped", "middle-6", { reason: "subagent-done" });
    // the subagent stop is accepted but does not satisfy the stop awaiter
    await expect(pending).rejects.toThrow();

    // the main agent's real Stop does resolve it
    const next = server.awaitStop("middle-6", 1000);
    await postHook("agent.stopped", "middle-6", { reason: "turn-end" });
    expect((await next).reason).toBe("turn-end");
  });

  test("a re-registered awaitStop is not evicted by an abandoned waiter's stale timeout", async () => {
    // The drive may abandon a pending awaitStop when its session dies (the
    // liveness race resolves first); a continuation then reuses the SAME
    // deterministic session name and awaits Stop afresh. The abandoned waiter's
    // stale timer must not evict the new one — otherwise the resumed drive's
    // real Stop is dropped and it spuriously times out.
    const abandoned = server.awaitStop("middle-6", 30);
    abandoned.catch(() => {}); // the original drive no longer cares
    const resumed = server.awaitStop("middle-6", 2000);
    await Bun.sleep(60); // let the abandoned 30ms timer fire
    await postHook("agent.stopped", "middle-6", { reason: "turn-end" });
    expect((await resumed).reason).toBe("turn-end");
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

describe("HookServer — recommender trigger endpoint", () => {
  test("404s when no trigger is wired (gate-only mode)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/trigger/recommender`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("wired trigger receives the posted repo and returns its status/body verbatim", async () => {
    const calls: Array<{ repoSlug?: string; repoPath?: string }> = [];
    const wired = new HookServer(undefined, undefined, async (req) => {
      calls.push(req);
      return { status: 202, body: "recommender run started" };
    });
    wired.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${wired.port}/trigger/recommender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: "/work/middle", repoSlug: "thejustinwalsh/middle" }),
      });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("recommender run started");
      expect(calls).toEqual([{ repoPath: "/work/middle", repoSlug: "thejustinwalsh/middle" }]);
    } finally {
      wired.stop();
    }
  });

  test("tolerates a garbled body — the trigger validates its own inputs", async () => {
    const wired = new HookServer(undefined, undefined, async (req) =>
      req.repoPath ? { status: 202, body: "ok" } : { status: 400, body: "repoPath required" },
    );
    wired.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${wired.port}/trigger/recommender`, {
        method: "POST",
        body: "not json",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("repoPath required");
    } finally {
      wired.stop();
    }
  });

  test("coerces non-string repoSlug/repoPath to undefined before forwarding", async () => {
    const calls: Array<{ repoSlug?: string; repoPath?: string }> = [];
    const wired = new HookServer(undefined, undefined, async (req) => {
      calls.push(req);
      return { status: 202, body: "ok" };
    });
    wired.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${wired.port}/trigger/recommender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Hostile types: a number, an object, and null must not pass through as strings.
        body: JSON.stringify({ repoSlug: 123, repoPath: { evil: true } }),
      });
      expect(res.status).toBe(202);
      // Neither field is a string, so both arrive as undefined (not 123 / [object Object]).
      expect(calls).toEqual([{ repoSlug: undefined, repoPath: undefined }]);
    } finally {
      wired.stop();
    }
  });

  test("a non-object JSON body (null, primitive, array) is treated as empty, not a 500", async () => {
    const calls: Array<{ repoSlug?: string; repoPath?: string }> = [];
    const wired = new HookServer(undefined, undefined, async (req) => {
      calls.push(req);
      // Mirror the real trigger: missing repoPath → 400, never a 500.
      return req.repoPath
        ? { status: 202, body: "ok" }
        : { status: 400, body: "repoPath required" };
    });
    wired.start(0);
    try {
      // `req.json()` parses each of these successfully, so the try/catch never
      // fires; the handler must still not dereference them.
      for (const raw of ["null", "123", '"a string"', "[1,2,3]", "true"]) {
        const res = await fetch(`http://127.0.0.1:${wired.port}/trigger/recommender`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        expect(res.status).toBe(400); // 400 from the trigger, never a 500 from the handler
      }
      // Every call saw an empty field bag, none threw.
      expect(calls).toEqual(Array(5).fill({ repoSlug: undefined, repoPath: undefined }));
    } finally {
      wired.stop();
    }
  });

  test("passes a string field through while dropping a non-string sibling", async () => {
    const calls: Array<{ repoSlug?: string; repoPath?: string }> = [];
    const wired = new HookServer(undefined, undefined, async (req) => {
      calls.push(req);
      return { status: 202, body: "ok" };
    });
    wired.start(0);
    try {
      await fetch(`http://127.0.0.1:${wired.port}/trigger/recommender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: "/work/middle", repoSlug: 42 }),
      });
      expect(calls).toEqual([{ repoPath: "/work/middle", repoSlug: undefined }]);
    } finally {
      wired.stop();
    }
  });
});

describe("HookServer — merged routes", () => {
  test("extraRoutes are served, and the fetch fallback still answers /health", async () => {
    const s = new HookServer();
    s.start(0, { "/api/ping": () => new Response("pong") });
    try {
      const ping = await fetch(`http://127.0.0.1:${s.port}/api/ping`);
      expect(await ping.text()).toBe("pong");
      const health = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("GET / no longer returns the status page (404 with no SPA route)", async () => {
    const s = new HookServer();
    s.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(res.status).toBe(404);
    } finally {
      s.stop();
    }
  });
});
