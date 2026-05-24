import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { setRateLimited } from "../src/rate-limits.ts";
import { countActiveImplementationSlots, getWorkflow } from "../src/workflow-record.ts";
import {
  assembleDocumentationPrompt,
  createDocumentationWorkflow,
  DOCS_WORKTREE_UNIT,
  type DocsTargetSummary,
  type DocumentationDeps,
  type DocumentationInput,
  sessionNameFor,
} from "../src/workflows/documentation.ts";
import { createWorktree, destroyWorktree, listWorktrees } from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

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
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-docs-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  engine = new Engine({ embedded: true });
});

afterEach(async () => {
  await engine.close(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";
const INPUT: DocumentationInput = { repo: REPO, adapter: "stub" };
const TARGET: DocsTargetSummary = {
  name: "starlight",
  docsRoot: "src/content/docs",
  supportsLlmsTxt: true,
};

/** Records every collaborator call into a shared trace, so step order is observable. */
function makeHarness(opts?: {
  write?: boolean;
  wirePersist?: boolean;
  failSession?: boolean;
  target?: DocsTargetSummary;
}) {
  const trace: string[] = [];
  const created: string[] = [];
  const killed: string[] = [];
  const sent: string[] = [];
  const persisted: Array<{ repo: string; worktreePath: string }> = [];

  const tmux = {
    async newSession(o: { sessionName: string }) {
      trace.push("spawn");
      created.push(o.sessionName);
    },
    async sendText(_s: string, text: string) {
      sent.push(text);
    },
    async sendEnter() {},
    async killSession(sessionName: string) {
      killed.push(sessionName);
    },
  };

  const adapter: AgentAdapter = {
    name: "stub",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: (o) => (o.kind === "docs" ? `/documenting-the-repo @${o.promptFile}` : "x"),
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

  const gate: SessionGate = {
    awaitSessionStart: async () => {
      if (opts?.failSession) throw new Error("launch timeout");
      return { session_id: "s", transcript_path: "/tmp/s.jsonl" } as HookPayload;
    },
    awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
  };

  const deps: DocumentationDeps = {
    db,
    getAdapter: () => adapter,
    sessionGate: gate,
    tmux,
    worktree: {
      async createWorktree(o) {
        trace.push("prepare");
        return createWorktree(o);
      },
      async destroyWorktree(h) {
        trace.push("cleanup");
        return destroyWorktree(h);
      },
    },
    resolveRepoPath: () => repoPath,
    worktreeRoot,
    dispatcherUrl: "http://127.0.0.1:8822",
    target: opts?.target ?? TARGET,
    config: { defaultAdapter: "claude", write: opts?.write ?? false },
    launchTimeoutMs: 2000,
    agentTimeoutMs: 2000,
    persistDocs: opts?.wirePersist
      ? async (o) => {
          trace.push("persist");
          persisted.push(o);
        }
      : undefined,
  };

  return { deps, trace, created, killed, sent, persisted };
}

async function runToEnd(deps: DocumentationDeps, timeoutMs = 5000): Promise<string> {
  engine.register(createDocumentationWorkflow(deps));
  const handle = await engine.start("documentation", INPUT);
  const terminal = new Set(["completed", "failed", "compensated", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = engine.getExecution(handle.id)?.state;
    if (s && terminal.has(s)) return handle.id;
    await Bun.sleep(15);
  }
  throw new Error(
    `documentation ${handle.id} did not settle (exec '${engine.getExecution(handle.id)?.state}')`,
  );
}

/** The step node's definition (name/timeout/retry/compensate), or undefined. */
function stepDef(deps: DocumentationDeps, name: string) {
  const wf = createDocumentationWorkflow(deps);
  const node = wf.nodes.find((n) => n.type === "step" && n.def.name === name);
  return node && node.type === "step" ? node.def : undefined;
}

describe("documentation workflow — shell: step order + dedicated slot", () => {
  test("declares the six steps in order", () => {
    const wf = createDocumentationWorkflow(makeHarness().deps);
    expect(wf.getStepNames()).toEqual([
      "check-rate-limit",
      "prepare-docs-worktree",
      "build-prompt",
      "spawn-docs-agent",
      "persist-docs",
      "cleanup-worktree",
    ]);
  });

  test("runs the steps in order at runtime and completes", async () => {
    const h = makeHarness();
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    expect(h.trace).toEqual(["prepare", "spawn", "cleanup"]);
    // The agent was launched with the docs slash command.
    expect(h.sent.some((t) => t.startsWith("/documenting-the-repo"))).toBe(true);
    // No worktree or session leaked.
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    for (const s of new Set(h.created)) expect(h.killed).toContain(s);
  });

  test("records its row with kind 'documentation' — its own dedicated slot, off maxConcurrent", async () => {
    const h = makeHarness();
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.kind).toBe("documentation");
    expect(getWorkflow(db, id)!.epicNumber).toBeNull();
    expect(countActiveImplementationSlots(db)).toEqual({ total: 0, perAdapter: {} });
  });

  test("claims the 'docs' worktree unit, distinct from the recommender's", async () => {
    // Drive prepare only far enough to register the worktree, then read its unit.
    let unit = "";
    const h = makeHarness();
    const realCreate = h.deps.worktree.createWorktree;
    h.deps.worktree.createWorktree = async (o) => {
      const handle = await realCreate(o);
      unit = handle.unit;
      return handle;
    };
    await runToEnd(h.deps);
    expect(unit).toBe(DOCS_WORKTREE_UNIT);
    expect(unit).toBe("docs");
  });

  test("spawn-docs-agent has the spec's 5-minute hard cap", () => {
    const h = makeHarness();
    delete (h.deps as { agentTimeoutMs?: number }).agentTimeoutMs;
    delete (h.deps as { launchTimeoutMs?: number }).launchTimeoutMs;
    const def = stepDef(h.deps, "spawn-docs-agent");
    expect(def).toBeDefined();
    expect(def!.timeout).toBe(90_000 + 5 * 60 * 1000 + 30_000);
  });

  test("prepare-docs-worktree registers a compensation handler", () => {
    expect(stepDef(makeHarness().deps, "prepare-docs-worktree")!.compensate).toBeDefined();
  });

  test("check-rate-limit does not retry", () => {
    expect(stepDef(makeHarness().deps, "check-rate-limit")!.retry).toBe(1);
  });

  test("a rate-limited adapter fails the run with state 'rate-limited'", async () => {
    setRateLimited(db, {
      adapter: "stub",
      resetAt: Date.parse("2099-01-01T00:00:00Z"),
      source: "transcript",
    });
    const h = makeHarness();
    engine.register(createDocumentationWorkflow(h.deps));
    const handle = await engine.start("documentation", INPUT);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = engine.getExecution(handle.id)?.state;
      if (s === "failed" || s === "completed") break;
      await Bun.sleep(15);
    }
    expect(engine.getExecution(handle.id)?.state).toBe("failed");
    expect(getWorkflow(db, handle.id)!.state).toBe("rate-limited");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
  });

  test("a launch failure compensates: worktree rolled back, session freed, state 'compensated'", async () => {
    const h = makeHarness({ failSession: true });
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("compensated");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    for (const s of new Set(h.created)) expect(h.killed).toContain(s);
  });
});

describe("documentation workflow — read-only/dry-run first: persist-docs gating", () => {
  test("write=false: persist seam is never invoked", async () => {
    const h = makeHarness({ write: false, wirePersist: true });
    await runToEnd(h.deps);
    expect(h.trace).not.toContain("persist");
    expect(h.persisted).toEqual([]);
  });

  test("write=true but persistDocs UNWIRED: still persists nothing (read-only first)", async () => {
    const h = makeHarness({ write: true, wirePersist: false });
    await runToEnd(h.deps);
    expect(h.trace).not.toContain("persist");
  });

  test("write=true and persistDocs wired: persist runs after the agent, before cleanup", async () => {
    const h = makeHarness({ write: true, wirePersist: true });
    await runToEnd(h.deps);
    expect(h.trace).toEqual(["prepare", "spawn", "persist", "cleanup"]);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.repo).toBe(REPO);
  });
});

describe("documentation workflow — assembleDocumentationPrompt", () => {
  test("reports the resolved target, audit mode, and config; invokes the skill via @-reference", async () => {
    const h = makeHarness();
    let written = "";
    const realDestroy = h.deps.worktree.destroyWorktree;
    h.deps.worktree.destroyWorktree = async (handle) => {
      const p = join(handle.path, ".middle", "prompt.md");
      if (existsSync(p)) written = readFileSync(p, "utf8");
      return realDestroy(handle);
    };
    await runToEnd(h.deps);

    expect(written).toContain('"name": "starlight"');
    expect(written).toContain('"docsRoot": "src/content/docs"');
    expect(written).toContain("`mode`: audit");
    expect(written).toContain('"write": false');
    expect(h.sent.some((t) => t === "/documenting-the-repo @.middle/prompt.md")).toBe(true);
  });

  test("includes the llms.txt audit line only when the target supports it", () => {
    const withLlms = assembleDocumentationPrompt({
      repo: REPO,
      target: { name: "starlight", docsRoot: "src/content/docs", supportsLlmsTxt: true },
      config: { defaultAdapter: "claude", write: false },
    });
    expect(withLlms).toContain("llms.txt");

    const withoutLlms = assembleDocumentationPrompt({
      repo: REPO,
      target: { name: "docusaurus", docsRoot: "docs", supportsLlmsTxt: false },
      config: { defaultAdapter: "claude", write: false },
    });
    expect(withoutLlms).not.toContain("llms.txt");
  });

  test("reports write=true to the agent when configured", () => {
    const prompt = assembleDocumentationPrompt({
      repo: REPO,
      target: TARGET,
      config: { defaultAdapter: "claude", write: true },
    });
    expect(prompt).toContain('"write": true');
  });
});

describe("documentation workflow — sessionNameFor collision-resistance", () => {
  const name = (repo: string) => sessionNameFor({ repo, adapter: "claude" });

  test("is deterministic for a given repo", () => {
    expect(name("thejustinwalsh/middle")).toBe(name("thejustinwalsh/middle"));
  });

  test("produces a tmux-safe session name under the docs namespace", () => {
    expect(name("the.just/in walsh/middle")).toMatch(/^middle-docs-[A-Za-z0-9_-]+-[0-9a-f]{1,8}$/);
  });

  test("distinct repos that share a lossy slug do not collide", () => {
    expect(name("a/b")).not.toBe(name("a-b"));
    expect(name("owner/repo")).not.toBe(name("owner/rep o"));
  });
});
