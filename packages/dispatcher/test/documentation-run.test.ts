import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, MiddleConfig } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import {
  dispatchDocumentation,
  resolveDocumentationOptions,
  type DispatchDocumentationOptions,
  type DocumentationRunOverrides,
} from "../src/documentation-run.ts";

let scratch: string;
let repoPath: string;

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
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-docsrun-")));
  repoPath = join(scratch, "repo");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function stubAdapter(): AgentAdapter {
  return {
    name: "claude",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: (o) => `/documenting-the-repo @${o.promptFile}`,
    async enterAutoMode() {},
    resolveTranscriptPath: (p) => p.transcript_path as string,
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
    classifyStop: () => ({ kind: "done" }),
  };
}

function makeOverrides(extra?: Partial<DocumentationRunOverrides>): DocumentationRunOverrides {
  const gate: SessionGate = {
    awaitSessionStart: async () =>
      ({ session_id: "s", transcript_path: "/tmp/s.jsonl" }) as HookPayload,
    awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
  };
  return {
    sessionGate: gate,
    tmux: {
      async newSession() {},
      async sendText() {},
      async sendEnter() {},
      async killSession() {},
    },
    ...extra,
  };
}

function baseOptions(
  dbPath: string,
  overrides: DocumentationRunOverrides,
): DispatchDocumentationOptions {
  return {
    repoPath,
    repoSlug: "thejustinwalsh/middle",
    adapterName: "claude",
    getAdapter: stubAdapter,
    dbPath,
    worktreeRoot: join(scratch, "worktrees"),
    dispatcherPort: 0,
    target: { name: "markdown", docsRoot: "docs", supportsLlmsTxt: true },
    runConfig: { defaultAdapter: "claude", write: false },
    overrides,
  };
}

/** A minimal config with the global defaults and the given `[docs]` block. */
function configWith(docs?: MiddleConfig["docs"]): MiddleConfig {
  return {
    global: {
      dispatcherPort: 0,
      maxConcurrent: 4,
      defaultAdapter: "claude",
      logDir: "/tmp/logs",
      worktreeRoot: join(scratch, "worktrees"),
      dbPath: join(scratch, "db.sqlite3"),
    },
    adapters: {},
    dashboard: { windowed: false, theme: "auto" },
    docs,
  };
}

describe("dispatchDocumentation — enqueues a documentation workflow (read-only)", () => {
  test("runs to completion and records a kind:'documentation' row for the repo", async () => {
    const dbPath = join(scratch, "db.sqlite3");
    const result = await dispatchDocumentation(baseOptions(dbPath, makeOverrides()));

    expect(result.state).toBe("completed");
    const db = openAndMigrate(dbPath);
    try {
      const row = db
        .query("SELECT kind, repo, epic_number, state FROM workflows WHERE id = ?")
        .get(result.workflowId) as {
        kind: string;
        repo: string;
        epic_number: number | null;
        state: string;
      };
      expect(row.kind).toBe("documentation");
      expect(row.repo).toBe("thejustinwalsh/middle");
      expect(row.epic_number).toBeNull();
      expect(row.state).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("is read-only: a clean run persists nothing (persistDocs stays unwired) even with write=true", async () => {
    const dbPath = join(scratch, "db.sqlite3");
    const opts = baseOptions(dbPath, makeOverrides());
    opts.runConfig.write = true;
    const result = await dispatchDocumentation(opts);
    expect(result.state).toBe("completed");
    // The run produced exactly one workflow row, no implementation/PR side effects.
    const db = openAndMigrate(dbPath);
    try {
      const rows = db.query("SELECT kind FROM workflows").all() as { kind: string }[];
      expect(rows).toEqual([{ kind: "documentation" }]);
    } finally {
      db.close();
    }
  });
});

describe("resolveDocumentationOptions", () => {
  test("rejects a non-claude adapter in Phase 1", async () => {
    const result = await resolveDocumentationOptions(
      repoPath,
      configWith({ enabled: true, intervalMinutes: 60, adapter: "codex", write: false }),
      stubAdapter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("only the 'claude' adapter");
  });

  test("resolves the markdown fallback target for a plain repo", async () => {
    const result = await resolveDocumentationOptions(repoPath, configWith(undefined), stubAdapter);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.target.name).toBe("markdown");
      expect(result.options.target.docsRoot).toBe("docs");
      expect(result.options.runConfig.write).toBe(false);
    }
  });

  test("honors a [docs] tool/path override", async () => {
    const result = await resolveDocumentationOptions(
      repoPath,
      configWith({
        enabled: true,
        intervalMinutes: 60,
        adapter: "claude",
        write: true,
        tool: "mkdocs",
        path: "site",
      }),
      stubAdapter,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.target.name).toBe("mkdocs");
      expect(result.options.target.docsRoot).toBe("site");
      expect(result.options.runConfig.write).toBe(true);
    }
  });

  test("surfaces an unknown tool override as an error rather than falling back", async () => {
    const result = await resolveDocumentationOptions(
      repoPath,
      configWith({
        enabled: true,
        intervalMinutes: 60,
        adapter: "claude",
        write: false,
        tool: "sphinx",
      }),
      stubAdapter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown docs tool "sphinx"');
  });
});
