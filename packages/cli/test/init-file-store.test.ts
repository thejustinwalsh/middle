import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isParseError, parseStateIssue, renderStateIssue, validate } from "@middle/state-issue";
import { parseEpicFile } from "@middle/dispatcher/src/epic-store/epic-file/parser.ts";
import type { EpicStoreRegistration } from "../src/commands/init.ts";
import { runInit } from "../src/commands/init.ts";
import type { BootstrapDeps } from "../src/bootstrap/types.ts";

// #194: `mm init --epic-store=file` scaffolds a local Epic store and makes ZERO
// `gh`/GitHub calls. These tests pin that contract (the four scaffold files +
// the setEpicStore seam + the no-gh invariant), and that github mode is unchanged.

/** A deps bundle that THROWS on every `gh`/GitHub-touching method. The file path
 *  must never reach any of these — git-only methods (clean worktree, remote URL,
 *  local repo info) are allowed since file mode is offline. */
function makeNoGhDeps(): BootstrapDeps {
  const die = (name: string) => () => {
    throw new Error(`gh call '${name}' must not happen in file mode`);
  };
  return {
    isCleanWorktree: async () => true,
    getRemoteUrl: async () => "git@github.com:acme/widget.git",
    isGhAuthenticated: die("isGhAuthenticated") as () => Promise<boolean>,
    resolveRepoInfo: die("resolveRepoInfo") as () => Promise<never>,
    resolveRepoInfoLocal: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    github: {
      ensureStateLabel: die("ensureStateLabel") as () => Promise<void>,
      createStateIssue: die("createStateIssue") as () => Promise<number>,
      closeStateIssue: die("closeStateIssue") as () => Promise<void>,
      findStateIssues: die("findStateIssues") as () => Promise<number[]>,
    },
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  };
}

/** A normal github-mode deps bundle (gh calls succeed). */
function makeGithubDeps(): {
  deps: BootstrapDeps;
  created: Array<{ title: string; body: string }>;
} {
  const created: Array<{ title: string; body: string }> = [];
  const deps: BootstrapDeps = {
    isCleanWorktree: async () => true,
    getRemoteUrl: async () => "git@github.com:acme/widget.git",
    isGhAuthenticated: async () => true,
    resolveRepoInfo: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    resolveRepoInfoLocal: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    github: {
      ensureStateLabel: async () => {},
      createStateIssue: async (_info, title, body) => {
        created.push({ title, body });
        return 142;
      },
      closeStateIssue: async () => {},
      findStateIssues: async () => [],
    },
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  };
  return { deps, created };
}

let repo: string;
let silence: () => void;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mm-init-file-"));
  mkdirSync(join(repo, ".git"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  silence = () => {
    log.mockRestore();
    err.mockRestore();
  };
});
afterEach(() => {
  silence();
  rmSync(repo, { recursive: true, force: true });
});

describe("mm init --epic-store=file", () => {
  test("writes the four scaffold files and makes zero gh calls", async () => {
    const code = await runInit(repo, { epicStore: "file", deps: makeNoGhDeps() });
    expect(code).toBe(0); // the no-gh deps never threw → no gh call happened

    // README explainer
    const readmePath = join(repo, "planning/epics/README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("file mode");
    expect(readme).toContain("<!-- middle:epic v1 -->"); // template snippet

    // .keep is present and empty
    const keepPath = join(repo, "planning/epics/.keep");
    expect(existsSync(keepPath)).toBe(true);
    expect(readFileSync(keepPath, "utf8")).toBe("");

    // state file carries the v1 marker and re-parses + validates
    const statePath = join(repo, ".middle/state.md");
    expect(existsSync(statePath)).toBe(true);
    const stateBody = readFileSync(statePath, "utf8");
    expect(stateBody).toContain("<!-- AGENT-QUEUE-STATE v1 -->");
    const parsed = parseStateIssue(stateBody);
    expect(isParseError(parsed)).toBe(false);
    if (!isParseError(parsed)) {
      // byte-identical round-trip — the dispatcher edits it section-by-section
      expect(renderStateIssue(parsed)).toBe(stateBody);
      expect(validate(parsed, { adapters: ["claude", "codex"] }).ok).toBe(true);
    }

    // per-repo [epic_store] config TOML, named <owner>-<name>.toml
    const tomlPath = join(repo, ".middle/acme-widget.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const toml = parseToml(readFileSync(tomlPath, "utf8")) as {
      epic_store: { mode: string; epics_dir: string; state_file: string };
    };
    expect(toml.epic_store.mode).toBe("file");
    expect(toml.epic_store.epics_dir).toBe("planning/epics");
    expect(toml.epic_store.state_file).toBe(".middle/state.md");

    // mode-agnostic writes still happen
    expect(existsSync(join(repo, ".claude/skills/implementing-github-issues/SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".middle/hooks/hook.sh"))).toBe(true);
    expect(existsSync(join(repo, ".middle/config.toml"))).toBe(true);

    // NO state issue created in file mode
    expect(existsSync(join(repo, ".github"))).toBe(false);
  });

  test("the README template snippet is a parseable v1 Epic body", async () => {
    await runInit(repo, { epicStore: "file", deps: makeNoGhDeps() });
    const readme = readFileSync(join(repo, "planning/epics/README.md"), "utf8");
    // extract the fenced ```md … ``` block and confirm parseEpicFile accepts it
    const fence = /```md\n([\s\S]*?)```/.exec(readme);
    expect(fence).not.toBeNull();
    const epic = parseEpicFile(fence![1]!);
    expect(epic.meta.slug).toBe("my-epic-slug");
    expect(epic.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  test("calls the setEpicStore callback with file mode + default paths", async () => {
    const calls: Array<{ repo: string; cfg: EpicStoreRegistration }> = [];
    const code = await runInit(repo, {
      epicStore: "file",
      deps: makeNoGhDeps(),
      setEpicStore: (r, cfg) => calls.push({ repo: r, cfg }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        repo: "acme/widget",
        cfg: { mode: "file", epicsDir: "planning/epics", stateFile: ".middle/state.md" },
      },
    ]);
  });

  test("a setEpicStore write failure is best-effort — init still succeeds", async () => {
    const code = await runInit(repo, {
      epicStore: "file",
      deps: makeNoGhDeps(),
      setEpicStore: () => {
        throw new Error("db locked");
      },
    });
    expect(code).toBe(0); // the throw is swallowed; the scaffold already landed
    expect(existsSync(join(repo, ".middle/state.md"))).toBe(true);
  });

  test("--dry-run writes nothing and makes no gh calls", async () => {
    const code = await runInit(repo, { epicStore: "file", dryRun: true, deps: makeNoGhDeps() });
    expect(code).toBe(0);
    expect(existsSync(join(repo, "planning/epics"))).toBe(false);
    expect(existsSync(join(repo, ".middle/state.md"))).toBe(false);
  });
});

describe("mm init — github mode is unchanged", () => {
  test("default mode creates the state issue and writes no file-store scaffold", async () => {
    const { deps, created } = makeGithubDeps();
    const code = await runInit(repo, { deps });
    expect(code).toBe(0);

    // github-mode artifacts
    expect(created).toHaveLength(1);
    expect(readFileSync(join(repo, ".middle/config.toml"), "utf8")).toContain("number = 142");

    // file-mode scaffold must NOT be written in github mode
    expect(existsSync(join(repo, "planning/epics"))).toBe(false);
    expect(existsSync(join(repo, ".middle/state.md"))).toBe(false);
    expect(existsSync(join(repo, ".middle/acme-widget.toml"))).toBe(false);
  });

  test("setEpicStore is called with github mode in the default path", async () => {
    const { deps } = makeGithubDeps();
    const calls: EpicStoreRegistration[] = [];
    await runInit(repo, { deps, setEpicStore: (_r, cfg) => calls.push(cfg) });
    expect(calls).toEqual([{ mode: "github" }]);
  });
});
