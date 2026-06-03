import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../../src/db.ts";
import {
  appendQuestion,
  buildFileGateways,
  buildGitHubGateways,
  makeRoutingEpicGateway,
  makeRoutingPollGateway,
} from "../../src/epic-store/index.ts";
import type {
  EpicPrLifecycle,
  PollGateway,
  PrSnapshot,
  RateLimitStatus,
} from "../../src/poller.ts";
import { ghGitHub } from "../../src/github.ts";
import { ghPollGateway } from "../../src/poller-gateway.ts";
import { ghStateIssueGateway } from "../../src/state-issue.ts";
import { readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import type { EpicFile } from "../../src/epic-store/epic-file/types.ts";
import { registerManagedRepo, setEpicStoreConfig } from "../../src/repo-config.ts";
import type { EpicGateway } from "../../src/github.ts";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedEpic(
  epicsDir: string,
  slug: string,
  conversation: EpicFile["conversation"] = [],
): void {
  writeFileSync(
    join(epicsDir, `${slug}.md`),
    renderEpicFile({
      title: "feat: x",
      meta: { slug },
      context: "ctx",
      acceptanceCriteria: [],
      subIssues: [],
      conversation,
    }),
  );
}

describe("buildGitHubGateways / buildFileGateways", () => {
  test("buildGitHubGateways defaults to the real gh-backed trio", () => {
    const trio = buildGitHubGateways();
    expect(trio.epicGateway).toBe(ghGitHub);
    expect(trio.stateGateway).toBe(ghStateIssueGateway);
    expect(trio.pollGateway).toBe(ghPollGateway);
  });

  test("buildFileGateways returns file-backed implementations (not the gh trio)", () => {
    const dir = tmpDir("middle-sel-");
    const trio = buildFileGateways({ epicsDir: dir, stateFile: join(dir, "state.md") });
    expect(trio.epicGateway).not.toBe(ghGitHub);
    expect(trio.pollGateway).not.toBe(ghPollGateway);
    expect(typeof trio.epicGateway.findEpicPr).toBe("function");
  });
});

describe("makeRoutingEpicGateway", () => {
  test("routes per-repo: file repo → file backend, github repo → gh backend", async () => {
    const scratch = tmpDir("middle-route-");
    const db = openAndMigrate(join(scratch, "db.sqlite3"));
    try {
      const repoDir = join(scratch, "repo");
      const epicsDir = join(repoDir, "planning", "epics");
      // file-mode repo with one Epic on disk
      mkdirSync(epicsDir, { recursive: true });
      seedEpic(epicsDir, "rollout", []);
      registerManagedRepo(db, "o/file", repoDir);
      setEpicStoreConfig(db, "o/file", {
        mode: "file",
        epicsDir: "planning/epics",
        stateFile: ".middle/state.md",
      });
      // github-mode repo: default config, gh backend recorded via a stub
      let ghLabelsCalled = 0;
      const ghStub = {
        ...ghGitHub,
        async getIssueLabels() {
          ghLabelsCalled += 1;
          return ["gh-label"];
        },
      } as unknown as EpicGateway;

      const router = makeRoutingEpicGateway({
        db,
        resolveRepoPath: () => repoDir,
        ghEpic: ghStub,
      });

      // file repo → reads the Epic file's meta (no labels set → [])
      expect(await router.getIssueLabels("o/file", "rollout")).toEqual([]);
      expect(ghLabelsCalled).toBe(0); // gh backend not consulted for a file repo

      // github repo (no config row) → delegates to the gh backend
      expect(await router.getIssueLabels("o/github", "7")).toEqual(["gh-label"]);
      expect(ghLabelsCalled).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("makeRoutingPollGateway", () => {
  test("a file-mode slug never reaches gh's numeric PR-finders; github delegates", async () => {
    const scratch = tmpDir("middle-pollroute-");
    const db = openAndMigrate(join(scratch, "db.sqlite3"));
    try {
      const repoDir = join(scratch, "repo");
      const epicsDir = join(repoDir, "planning", "epics");
      mkdirSync(epicsDir, { recursive: true });
      seedEpic(epicsDir, "rollout", []);
      registerManagedRepo(db, "o/file", repoDir);
      setEpicStoreConfig(db, "o/file", {
        mode: "file",
        epicsDir: "planning/epics",
        stateFile: ".middle/state.md",
      });
      const ghCalls: string[] = [];
      const ghPoll: PollGateway = {
        async listIssueComments() {
          return [];
        },
        async findPrForEpic(_repo, epicRef): Promise<PrSnapshot | null> {
          ghCalls.push(`findPr:${epicRef}`);
          return { number: 5, reviewDecision: null, reviews: [], labels: [] };
        },
        async findEpicPrLifecycle(): Promise<EpicPrLifecycle | null> {
          return { number: 5, state: "OPEN" };
        },
        async getRateLimit(): Promise<RateLimitStatus> {
          ghCalls.push("rate");
          return { remaining: 4999, resetAt: 0 };
        },
      };
      const router = makeRoutingPollGateway({ db, resolveRepoPath: () => repoDir, ghPoll });

      // file repo: the slug routes to the file poll gateway → null, gh never consulted.
      expect(await router.findPrForEpic("o/file", "rollout")).toBeNull();
      expect(ghCalls).toEqual([]);
      // github repo (no config): delegates to the gh poll backend.
      expect(await router.findPrForEpic("o/github", "7")).toMatchObject({ number: 5 });
      expect(ghCalls).toEqual(["findPr:7"]);
      // getRateLimit always delegates to gh (the budget is global, no repo).
      await router.getRateLimit();
      expect(ghCalls).toContain("rate");
    } finally {
      db.close();
    }
  });
});

describe("appendQuestion", () => {
  test("appends an open question block that re-parses; ids increment", () => {
    const dir = tmpDir("middle-q-");
    seedEpic(dir, "rollout", []);
    appendQuestion(dir, "rollout", {
      question: "A or B?",
      context: "some context",
      kind: "question",
      now: () => new Date("2026-06-03T00:00:00.000Z"),
    });
    let epic = readEpicFile(dir, "rollout")!;
    expect(epic.conversation).toEqual([
      {
        kind: "question",
        id: 1,
        status: "open",
        ts: "2026-06-03T00:00:00.000Z",
        questionKind: "question",
        body: "A or B?\n\nsome context",
      },
    ]);

    appendQuestion(dir, "rollout", {
      question: "more?",
      kind: "complexity",
      now: () => new Date("2026-06-03T01:00:00.000Z"),
    });
    epic = readEpicFile(dir, "rollout")!;
    expect(epic.conversation).toHaveLength(2);
    expect(epic.conversation[1]).toMatchObject({
      id: 2,
      questionKind: "complexity",
      body: "more?",
    });
  });

  test("throws a clear error when the Epic file is absent", () => {
    const dir = tmpDir("middle-q2-");
    expect(() => appendQuestion(dir, "nope", { question: "q", kind: "question" })).toThrow(
      /no Epic file for slug/,
    );
  });
});
