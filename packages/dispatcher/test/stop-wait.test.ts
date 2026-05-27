import { describe, expect, test } from "bun:test";
import type { HookPayload } from "@middle/core";
import { awaitStopOrSessionEnd } from "../src/workflows/implementation.ts";

/** A stop-hook stub that resolves after `ms` with the given payload. */
function stopAfter(ms: number, payload: HookPayload): () => Promise<HookPayload> {
  return () => new Promise((resolve) => setTimeout(() => resolve(payload), ms));
}

/** A stop-hook stub that never resolves — models an agent that never fires Stop. */
const stopNever = (): Promise<HookPayload> => new Promise(() => {});

/** A stop-hook stub that rejects after `ms` — models the gate's own timeout. */
function rejectAfter(ms: number): () => Promise<HookPayload> {
  return () =>
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

describe("awaitStopOrSessionEnd", () => {
  test("resolves via 'stop' when the Stop hook arrives first", async () => {
    const payload = { reason: "turn-end" } as HookPayload;
    const result = await awaitStopOrSessionEnd({
      awaitStop: stopAfter(5, payload),
      timeoutMs: 1000,
      isAlive: async () => true,
      pollMs: 5,
    });
    expect(result.via).toBe("stop");
    if (result.via === "stop") expect(result.payload).toBe(payload);
  });

  test("resolves via 'session-ended' when liveness goes false while Stop is pending", async () => {
    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 10);
    const result = await awaitStopOrSessionEnd({
      awaitStop: stopNever,
      timeoutMs: 1000,
      isAlive: async () => alive,
      pollMs: 5,
    });
    expect(result.via).toBe("session-ended");
  });

  test("resolves via 'timeout' when the Stop wait rejects and the session stays alive", async () => {
    const result = await awaitStopOrSessionEnd({
      awaitStop: rejectAfter(5),
      timeoutMs: 1000,
      isAlive: async () => true,
      pollMs: 50,
    });
    expect(result.via).toBe("timeout");
  });

  test("without a liveness probe, a rejected Stop wait surfaces as 'timeout'", async () => {
    const result = await awaitStopOrSessionEnd({
      awaitStop: rejectAfter(5),
      timeoutMs: 1000,
    });
    expect(result.via).toBe("timeout");
  });

  test("liveness-probe errors are ignored — a later Stop still wins", async () => {
    const payload = { reason: "turn-end" } as HookPayload;
    const result = await awaitStopOrSessionEnd({
      awaitStop: stopAfter(20, payload),
      timeoutMs: 1000,
      isAlive: async () => {
        throw new Error("tmux not running");
      },
      pollMs: 5,
    });
    expect(result.via).toBe("stop");
  });
});
