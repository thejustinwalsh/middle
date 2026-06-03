import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "@middle/core";
import {
  buildImplementationDeps,
  formatPauseComment,
  postQuestionComment,
} from "../src/build-deps.ts";
import { openAndMigrate } from "../src/db.ts";
import { AGENT_COMMENT_MARKER } from "../src/poller.ts";
import type { IssueComment } from "../src/gates/plan-comment.ts";
import type { PrReadyGateHandler } from "../src/gates/pr-ready-handler.ts";
import type { PullRequest } from "../src/github.ts";
import type { SessionGate } from "../src/hook-server.ts";

// `buildImplementationDeps` is the one canonical deps + gate construction the
// daemon consumes to host the implementation workflow. These tests prove the
// returned deps are correctly bound — and that the factory constructs no engine
// of its own (it never imports bunqueue).

let dir: string;
let dbPath: string;

/**
 * A stateful in-memory comment store modeling an Epic's comment thread: each
 * `postComment` appends, `listIssueComments` returns them chronologically. The
 * `url` carries a synthetic `#issuecomment-<n>` so any id-based logic resolves.
 */
function commentStore() {
  const comments: IssueComment[] = [];
  let next = 1;
  return {
    comments,
    listIssueComments: async () => comments.map((c) => ({ ...c })),
    postComment: async (_repo: string, _ref: string, body: string) => {
      comments.push({
        authorLogin: "agent-bot",
        body,
        url: `https://x/#issuecomment-${next++}`,
      });
    },
  };
}

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
      const findEpicPrCalls: Array<[string, string]> = [];
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
          listIssueComments: async () => [],
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
      const readiness = await deps.epicPrReadiness!("o/r", "5");
      expect(readiness).toEqual({ exists: true, isDraft: false });
      expect(findEpicPrCalls).toEqual([["o/r", "5"]]);
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
          listIssueComments: async () => [],
        },
        bindServer: () => ({ sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:1" }),
      });
      expect(await deps.epicPrReadiness!("o/r", "9")).toEqual({ exists: false, isDraft: false });
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
    const store = commentStore();
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
          getIssueLabels: async () => [],
          ...store,
        },
        bindServer: () => ({ sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:1" }),
      });
      await deps.postQuestion!({
        repo: "o/r",
        epicRef: "7",
        question: "4 designs, no winner",
        context: "A/B/C/D",
        kind: "complexity",
      });
      expect(store.comments).toHaveLength(1);
      // The complexity-pause framing the recommender keys off for its label.
      expect(store.comments[0]!.body).toContain("complexity pause");
      expect(store.comments[0]!.body).toContain("4 designs, no winner");
    } finally {
      db.close();
    }
  });

  test("the default postQuestion is idempotent on a repeated identical question (#205)", async () => {
    const store = commentStore();
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
          getIssueLabels: async () => [],
          ...store,
        },
        bindServer: () => ({ sessionGate: noopGate, dispatcherUrl: "http://127.0.0.1:1" }),
      });
      const ask = (question: string) =>
        deps.postQuestion!({ repo: "o/r", epicRef: "7", question, kind: "question" });

      // Three ticks of the SAME question → one comment, not three (the #177 spam).
      await ask("Which API base URL?");
      await ask("Which API base URL?");
      await ask("Which API base URL?");
      expect(store.comments).toHaveLength(1);

      // A DIFFERENT question is a new history entry — posts, never edits the prior.
      await ask("Should I bump the lockfile?");
      expect(store.comments).toHaveLength(2);
      expect(store.comments[0]!.body).toContain("Which API base URL?");
      expect(store.comments[1]!.body).toContain("Should I bump the lockfile?");

      // Re-asking the older question after a different one posts again (a history,
      // not a set) — only an identical-to-LATEST repeat is suppressed.
      await ask("Which API base URL?");
      expect(store.comments).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});

describe("postQuestionComment (idempotent pause poster, #205)", () => {
  const body = (q: string) => formatPauseComment({ question: q, kind: "question" });

  test("skips when the latest agent-comment already has the identical body", async () => {
    const store = commentStore();
    expect(
      await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q") }),
    ).toBe("posted");
    expect(
      await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q") }),
    ).toBe("skipped");
    expect(store.comments).toHaveLength(1);
  });

  test("a different body posts a fresh comment (questions are a history)", async () => {
    const store = commentStore();
    await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q1") });
    expect(
      await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q2") }),
    ).toBe("posted");
    expect(store.comments).toHaveLength(2);
  });

  test("ignores non-agent comments — only the marker-prefixed latest counts", async () => {
    const store = commentStore();
    await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q") });
    // A human reply (no marker) lands after the question; re-asking the SAME
    // question must still skip — the latest *agent* comment is the question.
    store.comments.push({ authorLogin: "human", body: "any update?", url: "https://x/#c-9" });
    expect(
      await postQuestionComment({ github: store, repo: "o/r", epicRef: "7", body: body("Q") }),
    ).toBe("skipped");
    expect(store.comments.filter((c) => c.body.startsWith(AGENT_COMMENT_MARKER))).toHaveLength(1);
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

  test("both kinds start with the hidden agent-comment marker so the poller skips them (#178)", () => {
    const question = formatPauseComment({ question: "Q", kind: "question" });
    const complexity = formatPauseComment({ question: "Q", context: "C", kind: "complexity" });
    expect(question.startsWith(AGENT_COMMENT_MARKER)).toBe(true);
    expect(complexity.startsWith(AGENT_COMMENT_MARKER)).toBe(true);
    // The marker is hidden (an HTML comment), so the visible prefixes still lead
    // the rendered body right after it.
    expect(question).toContain(`${AGENT_COMMENT_MARKER}\n🙋 **agent question**`);
    expect(complexity).toContain(`${AGENT_COMMENT_MARKER}\n🧩 **complexity pause**`);
  });
});
