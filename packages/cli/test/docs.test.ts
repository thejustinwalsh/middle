import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDocumentationOptions } from "@middle/dispatcher/src/documentation-run.ts";
import { runDocs } from "../src/commands/docs.ts";

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
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: GIT_ENV,
  });
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

function writeGlobal(extra: string[] = []): void {
  writeFileSync(
    configPath,
    [
      "[global]",
      'default_adapter = "claude"',
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      "",
      ...extra,
    ].join("\n"),
  );
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "middle-docs-cli-")));
  repoPath = join(dir, "repo");
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  configPath = join(dir, "global.toml");
  writeGlobal();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runDocs — input validation", () => {
  test("rejects a path that is not a git repository", async () => {
    const restore = silence();
    try {
      expect(await runDocs(join(dir, "nope"), { configPath })).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects an unknown [docs] tool override", async () => {
    mkdirSync(join(repoPath, ".middle"), { recursive: true });
    writeFileSync(
      join(repoPath, ".middle", "config.toml"),
      ["[docs]", 'tool = "sphinx"', ""].join("\n"),
    );
    const restore = silence();
    try {
      expect(await runDocs(repoPath, { configPath })).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("runDocs — enqueues a documentation run for the repo", () => {
  test("resolves the markdown fallback target and dispatches a read-only run", async () => {
    const calls: DispatchDocumentationOptions[] = [];
    const restore = silence();
    try {
      const code = await runDocs(repoPath, {
        configPath,
        dispatch: async (opts) => {
          calls.push(opts);
          return { workflowId: "wf-docs", state: "completed" };
        },
      });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    expect(calls).toHaveLength(1);
    const opts = calls[0]!;
    expect(opts.adapterName).toBe("claude");
    expect(opts.repoPath).toBe(repoPath);
    expect(opts.target.name).toBe("markdown");
    expect(opts.target.docsRoot).toBe("docs");
    // Read-only run-config: write defaults off.
    expect(opts.runConfig.write).toBe(false);
  });

  test("a [docs] tool/path override flows through to the resolved target", async () => {
    mkdirSync(join(repoPath, ".middle"), { recursive: true });
    writeFileSync(
      join(repoPath, ".middle", "config.toml"),
      ["[docs]", 'tool = "docusaurus"', 'path = "website/docs"', "write = true", ""].join("\n"),
    );
    const calls: DispatchDocumentationOptions[] = [];
    const restore = silence();
    try {
      const code = await runDocs(repoPath, {
        configPath,
        dispatch: async (opts) => {
          calls.push(opts);
          return { workflowId: "wf-docs", state: "completed" };
        },
      });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const opts = calls[0]!;
    expect(opts.target.name).toBe("docusaurus");
    expect(opts.target.docsRoot).toBe("website/docs");
    expect(opts.runConfig.write).toBe(true);
  });

  test("returns 1 when the dispatched run does not complete", async () => {
    const restore = silence();
    try {
      const code = await runDocs(repoPath, {
        configPath,
        dispatch: async () => ({ workflowId: "wf-x", state: "failed" }),
      });
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });
});
