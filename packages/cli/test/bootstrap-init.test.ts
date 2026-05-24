import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isParseError, parseStateIssue, validate } from "@middle/state-issue";
import { initRepo } from "../src/bootstrap/init.ts";
import { uninitRepo } from "../src/bootstrap/uninit.ts";
import { BOOTSTRAP_VERSION, type BootstrapDeps } from "../src/bootstrap/types.ts";

type Calls = {
  ensureLabel: number;
  created: Array<{ title: string; body: string }>;
  closed: Array<{ issue: number; comment: string }>;
};

function makeFakeDeps(): { deps: BootstrapDeps; calls: Calls } {
  const calls: Calls = { ensureLabel: 0, created: [], closed: [] };
  const deps: BootstrapDeps = {
    isCleanWorktree: async () => true,
    getRemoteUrl: async () => "git@github.com:acme/widget.git",
    isGhAuthenticated: async () => true,
    resolveRepoInfo: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    github: {
      ensureStateLabel: async () => {
        calls.ensureLabel++;
      },
      createStateIssue: async (_info, title, body) => {
        calls.created.push({ title, body });
        return 142;
      },
      closeStateIssue: async (_info, issue, comment) => {
        calls.closed.push({ issue, comment });
      },
    },
    now: () => new Date("2026-05-23T12:00:00.000Z"),
  };
  return { deps, calls };
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mm-init-"));
  mkdirSync(join(repo, ".git")); // validateTarget only checks for .git existence
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("mm init — fresh install", () => {
  test("stages skills, hooks, config, state issue, and gitignore", async () => {
    const { deps, calls } = makeFakeDeps();
    const result = await initRepo(repo, deps, { dryRun: false });

    expect(result.mode).toBe("fresh");
    expect(result.stateIssue).toBe(142);

    // skills, both CLIs — all three shipped skills, including the backlog-seeder
    for (const cli of [".claude", ".codex"]) {
      expect(existsSync(join(repo, cli, "skills/implementing-github-issues/SKILL.md"))).toBe(true);
      expect(existsSync(join(repo, cli, "skills/recommending-github-issues/SKILL.md"))).toBe(true);
      expect(existsSync(join(repo, cli, "skills/creating-github-issues/SKILL.md"))).toBe(true);
    }

    // hook script, executable
    const hookPath = join(repo, ".middle/hooks/hook.sh");
    expect(existsSync(hookPath)).toBe(true);
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);

    // per-CLI hook config
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(hookPath);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("agent.stopped");
    expect(readFileSync(join(repo, ".codex/config.toml"), "utf8")).toContain("[hooks]");

    // config with the captured issue number
    const config = readFileSync(join(repo, ".middle/config.toml"), "utf8");
    expect(config).toContain('owner = "acme"');
    expect(config).toContain("number = 142");
    expect(config).toContain("auto_dispatch = false");

    // gitignore
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".middle/");

    // github mutations
    expect(calls.ensureLabel).toBe(1);
    expect(calls.created).toHaveLength(1);
  });

  test("the created state-issue body parses and validates", async () => {
    const { deps, calls } = makeFakeDeps();
    await initRepo(repo, deps, { dryRun: false });
    const parsed = parseStateIssue(calls.created[0]!.body);
    expect(isParseError(parsed)).toBe(false);
    if (!isParseError(parsed)) {
      const v = validate(parsed, { adapters: ["claude", "codex"] });
      expect(v.ok).toBe(true);
    }
  });
});

describe("mm init — idempotent re-init", () => {
  test("a matching-version re-init refreshes assets but keeps config and issue", async () => {
    const { deps, calls } = makeFakeDeps();
    await initRepo(repo, deps, { dryRun: false });
    const configBefore = readFileSync(join(repo, ".middle/config.toml"), "utf8");

    const second = await initRepo(repo, deps, { dryRun: false });
    expect(second.mode).toBe("reinit");
    expect(second.stateIssue).toBe(142);
    expect(calls.created).toHaveLength(1); // no second issue created
    expect(readFileSync(join(repo, ".middle/config.toml"), "utf8")).toBe(configBefore);
  });
});

describe("mm init — dry run", () => {
  test("writes nothing and makes no GitHub calls", async () => {
    const { deps, calls } = makeFakeDeps();
    const result = await initRepo(repo, deps, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.stateIssue).toBe(0);
    expect(existsSync(join(repo, ".middle"))).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(calls.created).toHaveLength(0);
    expect(calls.ensureLabel).toBe(0);
    expect(result.actions.every((a) => a.startsWith("would"))).toBe(true);
  });
});

describe("mm init — validation", () => {
  test("rejects a dirty working tree", async () => {
    const { deps } = makeFakeDeps();
    deps.isCleanWorktree = async () => false;
    await expect(initRepo(repo, deps, { dryRun: false })).rejects.toThrow(/not clean/);
  });

  test("rejects a repo with no origin remote", async () => {
    const { deps } = makeFakeDeps();
    deps.getRemoteUrl = async () => null;
    await expect(initRepo(repo, deps, { dryRun: false })).rejects.toThrow(/no .*origin.* remote/);
  });

  test("fails fast on a malformed existing config instead of re-initializing fresh", async () => {
    const { deps, calls } = makeFakeDeps();
    mkdirSync(join(repo, ".middle"), { recursive: true });
    writeFileSync(join(repo, ".middle/config.toml"), "this is = not [[[ valid toml");
    await expect(initRepo(repo, deps, { dryRun: false })).rejects.toThrow(/malformed/);
    expect(calls.created).toHaveLength(0); // never mints a second state issue
  });
});

describe("mm init — existing config without a usable state issue", () => {
  test("a matching-version re-init with no issue number mints one and persists it", async () => {
    const { deps, calls } = makeFakeDeps();
    mkdirSync(join(repo, ".middle"), { recursive: true });
    writeFileSync(
      join(repo, ".middle/config.toml"),
      `[bootstrap]\nversion = ${BOOTSTRAP_VERSION}\n\n[state_issue]\nnumber = 0\n`,
    );
    const result = await initRepo(repo, deps, { dryRun: false });
    expect(result.mode).toBe("reinit");
    expect(result.stateIssue).toBe(142);
    expect(calls.created).toHaveLength(1);
    // the freshly-minted number must be written back to the config
    expect(readFileSync(join(repo, ".middle/config.toml"), "utf8")).toContain("number = 142");
  });
});

describe("mm uninit", () => {
  test("closes the issue and removes everything init staged", async () => {
    const { deps, calls } = makeFakeDeps();
    await initRepo(repo, deps, { dryRun: false });

    const result = await uninitRepo(repo, deps, { dryRun: false });
    expect(result.stateIssue).toBe(142);
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0]!.issue).toBe(142);

    expect(existsSync(join(repo, ".middle"))).toBe(false);
    expect(existsSync(join(repo, ".claude/skills/implementing-github-issues"))).toBe(false);
    expect(existsSync(join(repo, ".codex/skills/recommending-github-issues"))).toBe(false);
    // the backlog-seeder is removed from both CLIs too
    expect(existsSync(join(repo, ".claude/skills/creating-github-issues"))).toBe(false);
    expect(existsSync(join(repo, ".codex/skills/creating-github-issues"))).toBe(false);
    // init created .gitignore solely for `.middle/`; uninit removes the line and,
    // since the file is now empty, deletes it. Either way it must not survive with the line.
    const gi = join(repo, ".gitignore");
    if (existsSync(gi)) expect(readFileSync(gi, "utf8")).not.toContain(".middle/");
  });

  test("closes the state issue even when [repo] metadata is missing (deps fallback)", async () => {
    const { deps, calls } = makeFakeDeps();
    mkdirSync(join(repo, ".middle"), { recursive: true });
    // a config with an issue number but no [repo] block
    writeFileSync(join(repo, ".middle/config.toml"), "[state_issue]\nnumber = 142\n");
    const result = await uninitRepo(repo, deps, { dryRun: false });
    expect(result.stateIssue).toBe(142);
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0]!.issue).toBe(142);
  });

  test("dry run removes nothing", async () => {
    const { deps, calls } = makeFakeDeps();
    await initRepo(repo, deps, { dryRun: false });
    const result = await uninitRepo(repo, deps, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(calls.closed).toHaveLength(0);
    expect(existsSync(join(repo, ".middle"))).toBe(true);
    expect(existsSync(join(repo, ".claude/skills/implementing-github-issues"))).toBe(true);
  });

  test("strips only middle's hook entries, preserving foreign ones", async () => {
    const { deps } = makeFakeDeps();
    // Pre-seed a foreign hook entry alongside what init will add.
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude/settings.json"),
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] }, other: 1 },
        null,
        2,
      ),
    );
    await initRepo(repo, deps, { dryRun: false });
    await uninitRepo(repo, deps, { dryRun: false });

    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
    expect(settings.other).toBe(1);
    expect(settings.hooks.Stop).toContainEqual({
      hooks: [{ type: "command", command: "echo foreign" }],
    });
    // middle's own Stop entry (referencing hook.sh) is gone
    const middleEntries = settings.hooks.Stop.filter((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.some((h) => h.command.includes("hook.sh")),
    );
    expect(middleEntries).toHaveLength(0);
  });
});
