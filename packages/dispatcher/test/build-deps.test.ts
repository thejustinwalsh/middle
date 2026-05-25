import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { buildImplementationDeps, formatPauseComment } from "../src/build-deps.ts";
import { openAndMigrate } from "../src/db.ts";
import type { PrReadyGateHandler } from "../src/gates/pr-ready-handler.ts";
import type { PullRequest } from "../src/github.ts";
import type { SessionGate } from "../src/hook-server.ts";

// `buildImplementationDeps` is the one canonical deps + gate construction the
// daemon consumes to host the implementation workflow. These tests prove the
// returned deps are correctly bound — and that the factory constructs no engine
// of its own (it never imports bunqueue).

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
          postComment: async () => {},
          getIssueLabels: async () => [],
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
          postComment: async () => {},
          getIssueLabels: async () => [],
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

  test("the default postQuestion posts a gh comment framed by pause kind", async () => {
    const posted: Array<{ repo: string; issue: number; body: string }> = [];
    const db = openAndMigrate(dbPath);
    try {
      const { deps } = await buildImplementationDeps({
        db,
        getAdapter: () => fakeAdapter(),
        resolveRepoPath: () => "/p",
        worktreeRoot: dir,
        enqueueContinuation: async () => {},
        resolveAgentLogin: async () => undefined,
        github: {
          findEpicPr: async () => null,
          getCommentAuthor: async () => null,
          postComment: async (repo, issue, body) => {
            posted.push({ repo, issue, body });
          },
          getIssueLabels: async () => [],
        },
        bindServer: () => ({ sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:1" }),
      });
      await deps.postQuestion!({
        repo: "o/r",
        epicNumber: 7,
        question: "4 designs, no winner",
        context: "A/B/C/D",
        kind: "complexity",
      });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.repo).toBe("o/r");
      expect(posted[0]!.issue).toBe(7);
      // The complexity-pause framing the recommender keys off for its label.
      expect(posted[0]!.body).toContain("complexity pause");
      expect(posted[0]!.body).toContain("4 designs, no winner");
    } finally {
      db.close();
    }
  });
});

describe("formatPauseComment", () => {
  test("a complexity pause carries the `complexity pause` label vocabulary", () => {
    const body = formatPauseComment({ question: "Q", context: "C", kind: "complexity" });
    expect(body).toContain("complexity pause");
    expect(body).toContain("complexity_ceiling");
    expect(body).toContain("approved");
    expect(body).toContain("> Q");
    expect(body).toContain("C");
  });

  test("a plain question reads as an agent question, not a complexity pause", () => {
    const body = formatPauseComment({ question: "Q", kind: "question" });
    expect(body).toContain("agent question");
    expect(body).not.toContain("complexity pause");
    expect(body).toContain("> Q");
  });
});
