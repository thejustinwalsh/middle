import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import {
  getRateLimitState,
  markAvailable,
  markAvailableOnSuccess,
  parseResetAt,
  setRateLimited,
} from "../src/rate-limits.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-rl-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("rate_limit_state", () => {
  test("getRateLimitState is null until observed", () => {
    expect(getRateLimitState(db, "claude")).toBeNull();
  });

  test("setRateLimited records status, reset_at, and source", () => {
    const resetAt = Date.parse("2026-05-23T18:00:00Z");
    setRateLimited(db, { adapter: "claude", resetAt, source: "transcript", now: 1_000 });
    const state = getRateLimitState(db, "claude")!;
    expect(state.status).toBe("RATE_LIMITED");
    expect(state.resetAt).toBe(resetAt);
    expect(state.source).toBe("transcript");
    expect(state.observedAt).toBe(1_000);
  });

  test("setRateLimited upserts an existing adapter row", () => {
    setRateLimited(db, { adapter: "claude", resetAt: 1, source: "transcript", now: 1 });
    setRateLimited(db, { adapter: "claude", resetAt: 2, source: "stop-hook", now: 2 });
    const state = getRateLimitState(db, "claude")!;
    expect(state.resetAt).toBe(2);
    expect(state.source).toBe("stop-hook");
  });

  test("markAvailable clears the reset time", () => {
    setRateLimited(db, { adapter: "claude", resetAt: 999, source: "transcript" });
    markAvailable(db, "claude", 5_000);
    const state = getRateLimitState(db, "claude")!;
    expect(state.status).toBe("AVAILABLE");
    expect(state.resetAt).toBeNull();
  });

  test("markAvailableOnSuccess flips RATE_LIMITED → AVAILABLE and reports it", () => {
    setRateLimited(db, { adapter: "claude", resetAt: 999, source: "transcript" });
    expect(markAvailableOnSuccess(db, "claude")).toBe(true);
    expect(getRateLimitState(db, "claude")!.status).toBe("AVAILABLE");
  });

  test("markAvailableOnSuccess is a no-op when not rate-limited", () => {
    expect(markAvailableOnSuccess(db, "claude")).toBe(false); // never observed
    markAvailable(db, "claude");
    expect(markAvailableOnSuccess(db, "claude")).toBe(false); // already available
  });
});

describe("parseResetAt", () => {
  test("parses an ISO timestamp to unix ms", () => {
    expect(parseResetAt("2026-05-23T18:00:00Z")).toBe(Date.parse("2026-05-23T18:00:00Z"));
  });

  test("returns null for unrecognized text", () => {
    expect(parseResetAt("later today")).toBeNull();
  });
});
