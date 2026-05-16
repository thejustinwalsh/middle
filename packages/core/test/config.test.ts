import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

const GLOBAL_TOML = `
[global]
dispatcher_port = 8822
max_concurrent = 4
default_adapter = "claude"
log_dir = "~/.middle/logs"
worktree_root = "~/.middle/worktrees"
db_path = "~/.middle/db.sqlite3"

[adapters.claude]
enabled = true
binary = "claude"
permission_mode = "auto"
extra_args = []

[adapters.codex]
enabled = true
binary = "codex"
sandbox = "workspace-write"
approval_policy = "never"
extra_args = []

[dashboard]
windowed = false
theme = "auto"
`;

const REPO_TOML = `
[repo]
owner = "thejustinwalsh"
name = "middle"
default_branch = "main"
pr_mode = "single"

[limits]
max_concurrent = 3
max_concurrent_per_adapter = { claude = 2, codex = 1 }
complexity_ceiling = 3

[recommender]
enabled = true
interval_minutes = 15
adapter = "claude"
auto_dispatch = false

[state_issue]
number = 142
label = "agent-queue:state"

[bootstrap]
version = 1
installed_at = "2026-05-13T15:00:00Z"
`;

describe("loadConfig — global only", () => {
  test("parses the global sections and leaves per-repo sections undefined", () => {
    const config = loadConfig({ globalPath: write("global.toml", GLOBAL_TOML) });
    expect(config.global.dispatcherPort).toBe(8822);
    expect(config.global.maxConcurrent).toBe(4);
    expect(config.global.defaultAdapter).toBe("claude");
    expect(config.adapters.claude!.binary).toBe("claude");
    expect(config.adapters.claude!.permissionMode).toBe("auto");
    expect(config.adapters.codex!.sandbox).toBe("workspace-write");
    expect(config.dashboard.windowed).toBe(false);
    expect(config.repo).toBeUndefined();
    expect(config.limits).toBeUndefined();
  });

  test("expands ~ in path values", () => {
    const config = loadConfig({ globalPath: write("global.toml", GLOBAL_TOML) });
    expect(config.global.dbPath).toBe(join(homedir(), ".middle/db.sqlite3"));
    expect(config.global.logDir).toBe(join(homedir(), ".middle/logs"));
    expect(config.global.worktreeRoot).toBe(join(homedir(), ".middle/worktrees"));
  });
});

describe("loadConfig — per-repo merge", () => {
  test("populates per-repo sections alongside global", () => {
    const config = loadConfig({
      globalPath: write("global.toml", GLOBAL_TOML),
      repoPath: write("repo.toml", REPO_TOML),
    });
    expect(config.repo!.owner).toBe("thejustinwalsh");
    expect(config.repo!.prMode).toBe("single");
    expect(config.limits!.maxConcurrent).toBe(3);
    expect(config.limits!.maxConcurrentPerAdapter).toEqual({ claude: 2, codex: 1 });
    expect(config.limits!.complexityCeiling).toBe(3);
    expect(config.recommender!.intervalMinutes).toBe(15);
    expect(config.recommender!.autoDispatch).toBe(false);
    expect(config.stateIssue!.number).toBe(142);
    expect(config.bootstrap!.version).toBe(1);
  });

  test("per-repo values override global on a colliding key", () => {
    const repoOverride = `${REPO_TOML}\n[global]\nmax_concurrent = 2\ndefault_adapter = "codex"\n`;
    const config = loadConfig({
      globalPath: write("global.toml", GLOBAL_TOML),
      repoPath: write("repo.toml", repoOverride),
    });
    expect(config.global.maxConcurrent).toBe(2);
    expect(config.global.defaultAdapter).toBe("codex");
    // untouched global keys survive the merge
    expect(config.global.dispatcherPort).toBe(8822);
  });
});

describe("loadConfig — missing files", () => {
  test("missing global file falls back to documented defaults without throwing", () => {
    const config = loadConfig({ globalPath: join(dir, "does-not-exist.toml") });
    expect(config.global.dispatcherPort).toBe(8822);
    expect(config.global.maxConcurrent).toBe(4);
    expect(config.adapters.claude!.enabled).toBe(true);
    expect(config.repo).toBeUndefined();
  });

  test("missing per-repo file leaves per-repo sections undefined", () => {
    const config = loadConfig({
      globalPath: write("global.toml", GLOBAL_TOML),
      repoPath: join(dir, "no-repo.toml"),
    });
    expect(config.global.dispatcherPort).toBe(8822);
    expect(config.repo).toBeUndefined();
    expect(config.recommender).toBeUndefined();
  });

  test("no paths at all yields an all-defaults config", () => {
    const config = loadConfig({});
    expect(config.global.maxConcurrent).toBe(4);
    expect(config.dashboard.theme).toBe("auto");
    expect(config.repo).toBeUndefined();
  });
});
