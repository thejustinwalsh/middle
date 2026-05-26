import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../../src/db.ts";
import {
  type CheckboxRevertPassDeps,
  runCheckboxRevertPass,
} from "../../src/gates/checkbox-revert-pass.ts";
import { evidenceMarker } from "../../src/gates/gate-evidence.ts";
import { parseVerifyConfig } from "../../src/gates/verify-config.ts";
import type { GitHubGateway, PullRequest } from "../../src/github.ts";
import {
  createWorkflowRecord,
  getCheckboxReconcileState,
  setCheckboxReconcileState,
  updateWorkflow,
} from "../../src/workflow-record.ts";

// A gate that passes for phase 100, one that fails for phase 101 — the same
// fixture verify.test.ts uses, so the gate-run behavior is exercised for real.
const CONFIG = parseVerifyConfig(
  [
    "[[gate]]",
    'name = "pass-gate"',
    'command = "echo green"',
    "phases = [100]",
    "",
    "[[gate]]",
    'name = "fail-gate"',
    'command = "echo boom >&2; exit 1"',
    "phases = [101]",
  ].join("\n"),
);

const REPO = "o/r";
const PR_NUMBER = 99;

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cbrp-"));
  db = openAndMigrate(join(dir, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A scratch worktree the gates' `cwd` points at (the echo commands need a real dir). */
function scratchWorktree(): string {
  return mkdtempSync(join(tmpdir(), "middle-cbrp-wt-"));
}

/** In-memory GitHub stub: a mutable Epic PR (body + headSha) and a comment log. */
function fakeGithub(opts: { body: string; headSha?: string; epicNumber?: number }) {
  const pr: PullRequest = {
    number: PR_NUMBER,
    body: opts.body,
    isDraft: true,
    headSha: opts.headSha,
  };
  const comments: Array<{ id: number; body: string }> = [];
  let nextId = 1;
  let findCalls = 0;
  const unimplemented = (name: string) => (): never => {
    throw new Error(`fakeGithub.${name} not implemented`);
  };
  const github: GitHubGateway = {
    async findEpicPr(_repo, epic) {
      findCalls++;
      return epic === (opts.epicNumber ?? 1) ? pr : null;
    },
    async editPullRequestBody(_repo, _num, body) {
      pr.body = body;
    },
    async postComment(_repo, _issue, body) {
      comments.push({ id: nextId++, body });
    },
    async listIssueComments(_repo, _issue) {
      return comments.map((c) => ({
        authorLogin: "agent",
        body: c.body,
        url: `https://github.com/${REPO}/pull/${PR_NUMBER}#issuecomment-${c.id}`,
      }));
    },
    async editComment(_repo, id, body) {
      const c = comments.find((x) => x.id === id);
      if (c) c.body = body;
    },
    getPullRequest: unimplemented("getPullRequest"),
    getCommentAuthor: unimplemented("getCommentAuthor"),
    getIssueLabels: unimplemented("getIssueLabels"),
    listOpenEpics: unimplemented("listOpenEpics"),
  };
  return {
    github,
    pr,
    comments,
    get findCalls() {
      return findCalls;
    },
  };
}

/** Seed a running implementation workflow on the given worktree. */
function seedRunning(id: string, worktreePath: string, epicNumber = 1): void {
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicNumber,
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "running", worktreePath });
}

/** Build pass deps with the injected gateway + an in-memory config loader. */
function passDeps(
  github: GitHubGateway,
  over: Partial<CheckboxRevertPassDeps> = {},
): CheckboxRevertPassDeps {
  return {
    db,
    github,
    getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
    loadConfig: () => CONFIG,
    ...over,
  };
}

const STATUS = (boxes: string[]) =>
  ["## Summary", "Closes #1", "", "## Status", ...boxes, ""].join("\n");

describe("runCheckboxRevertPass", () => {
  test("reverts a failing-gate checkbox after a push: body, comment, persisted state", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "sha1" });

      const reverted = await runCheckboxRevertPass(passDeps(gh.github));

      expect(reverted).toBe(1);
      expect(gh.pr.body).toContain("- [ ] #101 — fails"); // reverted
      // A revert notice naming the failed gate, plus the evidence comment.
      expect(
        gh.comments.some((c) => c.body.includes("reverted") && c.body.includes("fail-gate")),
      ).toBe(true);
      expect(gh.comments.some((c) => c.body.includes(evidenceMarker(101)))).toBe(true);
      // Diff base persisted: the SHA we serviced + the post-revert (unchecked) state.
      expect(getCheckboxReconcileState(db, "w")).toEqual({
        headSha: "sha1",
        state: { 101: false },
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a passing-gate checkbox stays checked; SHA + state persisted", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      const gh = fakeGithub({ body: STATUS(["- [x] #100 — passes"]), headSha: "sha1" });

      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(0);
      expect(gh.pr.body).toContain("- [x] #100 — passes");
      expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: "sha1", state: { 100: true } });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("head-SHA gate: an unchanged SHA skips a would-be transition entirely", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      // Persisted SHA matches the PR's; the empty state means #101 *would* be a
      // fresh transition — but the SHA gate must short-circuit before gates run.
      setCheckboxReconcileState(db, "w", { headSha: "sha1", state: {} });
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "sha1" });

      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(0);
      expect(gh.pr.body).toContain("- [x] #101 — fails"); // untouched
      expect(gh.comments).toHaveLength(0); // no gate run, no revert
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("an advanced SHA re-processes: the new transition's gate runs and reverts", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      setCheckboxReconcileState(db, "w", { headSha: "old", state: {} });
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "new" });

      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(1);
      expect(gh.pr.body).toContain("- [ ] #101 — fails");
      expect(getCheckboxReconcileState(db, "w").headSha).toBe("new");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("undefined gateway SHA falls through to the reconciler's checkbox-state diff", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]) }); // no headSha

      // First pass: empty state → #101 is a fresh transition → fails → reverted.
      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(1);
      expect(gh.pr.body).toContain("- [ ] #101 — fails");
      const commentsAfterFirst = gh.comments.length;

      // Second pass: SHA still undefined (no gate), but the box is now [ ] and the
      // persisted state records it unchecked → no transition → no re-revert.
      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(0);
      expect(gh.comments).toHaveLength(commentsAfterFirst);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("no usable verify.toml → the workflow is skipped (nothing to enforce)", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "sha1" });

      expect(await runCheckboxRevertPass(passDeps(gh.github, { loadConfig: () => null }))).toBe(0);
      expect(gh.pr.body).toContain("- [x] #101 — fails");
      expect(gh.comments).toHaveLength(0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("rate-limit ceiling skips the whole pass before any GitHub call", async () => {
    const wt = scratchWorktree();
    try {
      seedRunning("w", wt);
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "sha1" });

      const reverted = await runCheckboxRevertPass(
        passDeps(gh.github, {
          getRateLimit: async () => ({ remaining: 10, resetAt: 0 }),
          rateLimitBuffer: 100,
        }),
      );
      expect(reverted).toBe(0);
      expect(gh.findCalls).toBe(0); // never reached the per-workflow PR read
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a per-workflow failure is isolated — other workflows still process", async () => {
    const wtBad = scratchWorktree();
    const wtGood = scratchWorktree();
    try {
      seedRunning("bad", wtBad, 1);
      seedRunning("good", wtGood, 2);
      const good = fakeGithub({
        body: STATUS(["- [x] #101 — fails"]),
        headSha: "sha1",
        epicNumber: 2,
      });
      const github: GitHubGateway = {
        ...good.github,
        async findEpicPr(repo, epic) {
          if (epic === 1) throw new Error("GitHub down");
          return good.github.findEpicPr(repo, epic);
        },
      };

      const reverted = await runCheckboxRevertPass(passDeps(github));
      expect(reverted).toBe(1); // the good workflow's box was reverted despite the bad one throwing
      expect(good.pr.body).toContain("- [ ] #101 — fails");
    } finally {
      rmSync(wtBad, { recursive: true, force: true });
      rmSync(wtGood, { recursive: true, force: true });
    }
  });

  test("a parked (non-running) workflow is not processed", async () => {
    const wt = scratchWorktree();
    try {
      createWorkflowRecord(db, {
        id: "w",
        kind: "implementation",
        repo: REPO,
        epicNumber: 1,
        adapter: "claude",
      });
      updateWorkflow(db, "w", { state: "waiting-human", worktreePath: wt });
      const gh = fakeGithub({ body: STATUS(["- [x] #101 — fails"]), headSha: "sha1" });

      expect(await runCheckboxRevertPass(passDeps(gh.github))).toBe(0);
      expect(gh.findCalls).toBe(0);
      expect(gh.pr.body).toContain("- [x] #101 — fails");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
