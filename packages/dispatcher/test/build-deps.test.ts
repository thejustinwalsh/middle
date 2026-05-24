import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { buildImplementationDeps } from "../src/build-deps.ts";
import { openAndMigrate } from "../src/db.ts";
import type { PrReadyGateHandler } from "../src/gates/pr-ready-handler.ts";
import type { PullRequest } from "../src/github.ts";
import type { SessionGate } from "../src/hook-server.ts";

// `buildImplementationDeps` extracts the deps + gate construction that lived
// inline in `dispatchEpic`, so the daemon and the standalone path share one
// wiring. These tests prove the returned deps are correctly bound — and that
// the factory constructs no engine of its own (it never imports bunqueue).

let dir: string;
let dbPath: string;

const noopGate: SessionGate = {
  awaitSessionStart: async () => ({}),
  awaitStop: async () => ({}),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-build-deps-"));
  dbPath = join(dir, "db.sqlite3");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeAdapter(): AgentAdapter {
  return { name: "claude" } as unknown as AgentAdapter;
}

describe("buildImplementationDeps", () => {
  test("wires deps from the injected collaborators and returns the gate it built", async () => {
    const db = openAndMigrate(dbPath);
    try {
      const epicPr: PullRequest = { number: 7, body: "Closes #5", isDraft: false };
      const findEpicPrCalls: Array<[string, number]> = [];
      const getAdapter = (name: string): AgentAdapter => {
        if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
        return fakeAdapter();
      };
      const enqueueContinuation = async (): Promise<void> => {};

      let boundGate: PrReadyGateHandler | undefined;
      const { deps, prReadyGate } = await buildImplementationDeps({
        db,
        repoSlug: "o/r",
        getAdapter,
        resolveRepoPath: () => "/checkout/path",
        worktreeRoot: join(dir, "worktrees"),
        enqueueContinuation,
        resolveAgentLogin: async () => "agent-bot",
        github: {
          findEpicPr: async (repo, n) => {
            findEpicPrCalls.push([repo, n]);
            return epicPr;
          },
          getCommentAuthor: async () => null,
        },
        bindServer: (gate) => {
          boundGate = gate;
          return { sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:4242" };
        },
      });

      // The gate handed to bindServer is exactly the one returned to the caller.
      expect(typeof prReadyGate).toBe("function");
      expect(boundGate).toBe(prReadyGate);

      // SessionGate + URL come straight from bindServer (the post-start values).
      expect(deps.sessionGate).toBe(noopGate);
      expect(deps.dispatcherUrl).toBe("http://127.0.0.1:4242");

      // enqueueContinuation is the injected callback, by identity.
      expect(deps.enqueueContinuation).toBe(enqueueContinuation);

      // agentLogin is the awaited resolver result.
      expect(deps.agentLogin).toBe("agent-bot");

      // resolveRepoPath / worktreeRoot / getAdapter pass through.
      expect(deps.resolveRepoPath("ignored")).toBe("/checkout/path");
      expect(deps.worktreeRoot).toBe(join(dir, "worktrees"));
      expect(deps.getAdapter).toBe(getAdapter);

      // epicPrReadiness delegates to github.findEpicPr.
      const readiness = await deps.epicPrReadiness!("o/r", 5);
      expect(readiness).toEqual({ exists: true, isDraft: false });
      expect(findEpicPrCalls).toEqual([["o/r", 5]]);
    } finally {
      db.close();
    }
  });

  test("epicPrReadiness reports a missing PR as { exists: false, isDraft: false }", async () => {
    const db = openAndMigrate(dbPath);
    try {
      const { deps } = await buildImplementationDeps({
        db,
        repoSlug: "o/r",
        getAdapter: () => fakeAdapter(),
        resolveRepoPath: () => "/p",
        worktreeRoot: dir,
        enqueueContinuation: async () => {},
        resolveAgentLogin: async () => undefined,
        github: {
          findEpicPr: async () => null,
          getCommentAuthor: async () => null,
        },
        bindServer: () => ({ sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:1" }),
      });
      expect(await deps.epicPrReadiness!("o/r", 9)).toEqual({ exists: false, isDraft: false });
      expect(deps.agentLogin).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("the factory module imports no engine (no bunqueue construction)", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "src", "build-deps.ts")).text();
    expect(src).not.toContain("bunqueue");
    expect(src).not.toMatch(/new Engine/);
  });
});
