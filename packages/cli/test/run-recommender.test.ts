import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchRecommenderOptions } from "@middle/dispatcher/src/recommender-run.ts";
import { runRecommender } from "../src/commands/run-recommender.ts";

let dir: string;
let repoPath: string;
let configPath: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "middle-test",
  GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
  GIT_COMMITTER_NAME: "middle-test",
  GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
};

async function git(cwd: string, args: string[]): Promise<void> {
  // Fail loud on a non-zero exit so a broken fixture surfaces here, not as a
  // misleading assertion failure further down. stderr is captured for the message.
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe", env: GIT_ENV });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}): ${await new Response(proc.stderr).text()}`);
  }
}

function silence(): () => void {
  const e = spyOn(console, "error").mockImplementation(() => {});
  const l = spyOn(console, "log").mockImplementation(() => {});
  return () => {
    e.mockRestore();
    l.mockRestore();
  };
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "middle-runrec-")));
  repoPath = join(dir, "repo");
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  // Phase 7 schema lives at the repo root.
  mkdirSync(join(repoPath, "schemas"), { recursive: true });
  writeFileSync(join(repoPath, "schemas", "state-issue.v1.md"), "# schema\n");
  // Per-repo config with a state issue number.
  mkdirSync(join(repoPath, ".middle"), { recursive: true });
  writeFileSync(
    join(repoPath, ".middle", "config.toml"),
    ['[state_issue]', "number = 42", 'label = "agent-queue:state"', ""].join("\n"),
  );
  configPath = join(dir, "global.toml");
  writeFileSync(
    configPath,
    [
      "[global]",
      "default_adapter = \"claude\"",
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runRecommender — input validation", () => {
  test("rejects a path that is not a git repository", async () => {
    const restore = silence();
    try {
      expect(await runRecommender(join(dir, "nope"), { configPath })).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects when no state issue is configured for the repo", async () => {
    // A repo with no per-repo config (no state_issue).
    const bare = join(dir, "bare");
    mkdirSync(join(bare, "schemas"), { recursive: true });
    await git(bare, ["init"]);
    writeFileSync(join(bare, "schemas", "state-issue.v1.md"), "# schema\n");
    const restore = silence();
    try {
      expect(await runRecommender(bare, { configPath })).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects when the state-issue schema is missing", async () => {
    rmSync(join(repoPath, "schemas"), { recursive: true, force: true });
    const restore = silence();
    try {
      expect(await runRecommender(repoPath, { configPath })).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("runRecommender — enqueues a recommender workflow for the repo", () => {
  test("resolves config and dispatches a recommender run with the repo's state issue + adapter", async () => {
    const calls: DispatchRecommenderOptions[] = [];
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        dispatch: async (opts) => {
          calls.push(opts);
          return { workflowId: "wf-test", state: "completed" };
        },
      });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    expect(calls).toHaveLength(1);
    const opts = calls[0]!;
    expect(opts.stateIssue).toBe(42); // from the repo's config
    expect(opts.adapterName).toBe("claude");
    expect(opts.repoPath).toBe(repoPath);
    expect(opts.schemaPath).toBe(join(repoPath, "schemas", "state-issue.v1.md"));
    // Read-only run-config: autoDispatch defaults off.
    expect(opts.runConfig.autoDispatch).toBe(false);
  });

  test("returns 1 when the dispatched run does not complete", async () => {
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        dispatch: async () => ({ workflowId: "wf-x", state: "failed" }),
      });
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });
});
