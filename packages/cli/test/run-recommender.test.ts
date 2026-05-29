import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "middle-runrec-")));
  repoPath = join(dir, "repo");
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  // No per-repo schema fixture: runRecommender is a thin daemon client (it never
  // reads the schema), and the recommender resolves it from the @middle/state-issue
  // package, not <repo>/schemas/ (issue #107).
  // Per-repo config with a state issue number.
  mkdirSync(join(repoPath, ".middle"), { recursive: true });
  writeFileSync(
    join(repoPath, ".middle", "config.toml"),
    ["[state_issue]", "number = 42", 'label = "agent-queue:state"', ""].join("\n"),
  );
  configPath = join(dir, "global.toml");
  writeFileSync(
    configPath,
    [
      "[global]",
      'default_adapter = "claude"',
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runRecommender — local validation", () => {
  test("rejects a path that is not a git repository", async () => {
    const restore = silence();
    try {
      expect(await runRecommender(join(dir, "nope"), { configPath })).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("runRecommender — thin client to the daemon", () => {
  const up = async () => true;
  const down = async () => false;

  test("daemon already up: POSTs /trigger/recommender and returns 0 on 202", async () => {
    const posted: Array<{ base: string; repoPath: string }> = [];
    let started = 0;
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        probeHealth: up,
        startDaemon: () => {
          started++;
          return 0;
        },
        trigger: async (base, rp) => {
          posted.push({ base, repoPath: rp });
          return { status: 202, body: "recommender run started" };
        },
      });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    expect(started).toBe(0); // already up → not started
    expect(posted).toHaveLength(1);
    expect(posted[0]!.repoPath).toBe(repoPath); // resolved absolute checkout path
    expect(posted[0]!.base).toBe("http://127.0.0.1:4120"); // the configured dispatcher port (default)
  });

  test("daemon down: auto-starts it, waits for health, then triggers", async () => {
    let started = 0;
    let probes = 0;
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        probeHealth: async () => probes++ > 0, // down on the first probe, up after start
        startDaemon: () => {
          started++;
          return 0;
        },
        trigger: async () => ({ status: 202, body: "recommender run started" }),
      });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    expect(started).toBe(1); // it was down → auto-started, like `mm dispatch`
  });

  test("relays a daemon rejection (non-202) as exit 1", async () => {
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        probeHealth: up,
        startDaemon: () => 0,
        trigger: async () => ({ status: 400, body: "no state issue configured for this repo" }),
      });
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });

  test("returns 1 when the daemon never becomes ready after an auto-start", async () => {
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        probeHealth: down, // never ready
        startDaemon: () => 0,
        healthTimeoutMs: 30,
        trigger: async () => ({ status: 202, body: "x" }),
      });
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });

  test("returns 1 when the dispatcher is unreachable (the POST throws)", async () => {
    const restore = silence();
    try {
      const code = await runRecommender(repoPath, {
        configPath,
        probeHealth: up,
        startDaemon: () => 0,
        trigger: async () => {
          throw new Error("connection refused");
        },
      });
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });
});
