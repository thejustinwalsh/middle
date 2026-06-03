/**
 * Integration: file-mode auto-dispatch reads the repo's `state_file` (not a
 * GitHub state issue) and dispatches its ranked Epics **by slug** (#200 gap 2).
 *
 * Drives the genuine wiring: a ranked `state_file` on disk → `readState` through
 * `makeRoutingStateGateway` (file mode for this repo, issue number ignored) →
 * `parseStateIssue` → `autoDispatch` walking the Ready table → `enqueue` with the
 * file Epic's **slug** ref. Before this gap closed, auto-dispatch always read the
 * GitHub state issue and `parseEpicNumber` dropped any non-numeric (slug) cell.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderStateIssue, type ParsedState, type ReadyRow } from "@middle/state-issue";
import { openAndMigrate } from "../../src/db.ts";
import { makeRoutingStateGateway } from "../../src/epic-store/index.ts";
import { autoDispatch } from "../../src/auto-dispatch.ts";
import { readState } from "../../src/state-issue.ts";
import { setEpicStoreConfig } from "../../src/repo-config.ts";
import type { SlotState } from "../../src/slots.ts";

const REPO = "o/file-repo";
const STATE_FILE_REL = ".middle/state.md";

let scratch: string;
let db: Database;
let repoRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-file-autodispatch-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  repoRoot = join(scratch, "repo");
  setEpicStoreConfig(db, REPO, {
    mode: "file",
    epicsDir: "planning/epics",
    stateFile: STATE_FILE_REL,
  });
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Render a full state body with the given Ready rows and write it to the state_file. */
function writeStateFile(ready: ReadyRow[]): void {
  const state: ParsedState = {
    version: 1,
    generated: "2026-06-03T00:00:00.000Z",
    runId: "abcd1234",
    intervalMinutes: 15,
    readyToDispatch: ready,
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "AVAILABLE", github: "UNKNOWN" },
    slotUsage: {
      adapters: [{ adapter: "claude", used: 0, max: 2 }],
      total: { used: 0, max: 3 },
      global: { used: 0, max: 4 },
    },
  };
  const path = join(repoRoot, STATE_FILE_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderStateIssue(state));
}

function openSlots(): SlotState {
  const dim = (used: number, max: number) => ({ used, max, available: Math.max(0, max - used) });
  return { byAdapter: { claude: dim(0, 2) }, repo: dim(0, 3), global: dim(0, 4) };
}

describe("file-mode auto-dispatch (real readState path)", () => {
  test("reads the state_file and enqueues a file Epic by its slug ref", async () => {
    writeStateFile([
      {
        rank: 1,
        epic: "#rollout-epic-store Roll out the store",
        adapter: "claude",
        subIssues: 3,
        reason: "ready",
      },
    ]);
    const stateGateway = makeRoutingStateGateway({ db, resolveRepoPath: () => repoRoot });
    const enqueued: Array<{ repo: string; epicRef: string; adapter: string }> = [];

    const result = await autoDispatch({
      repo: REPO,
      isAutoDispatchEnabled: () => true,
      // The sentinel issue number (0) is ignored by the file state gateway — it
      // reads the configured state_file. This is exactly main.ts's file-mode call.
      readState: () => readState(stateGateway, REPO, 0),
      rateLimitedAdapters: () => new Set<string>(),
      getSlotState: openSlots,
      enqueue: async (input) => {
        enqueued.push(input);
        return `wf-${input.epicRef}`;
      },
    });

    expect(enqueued).toEqual([{ repo: REPO, epicRef: "rollout-epic-store", adapter: "claude" }]);
    expect(result.reason).toBe("drained");
  });

  test("a github-mode repo still routes readState to the gh state issue gateway", async () => {
    // No file config for this repo → the router falls through to the injected gh
    // state backend, proving the router doesn't hijack github repos.
    const ghRepo = "o/gh-repo";
    const readArgs: Array<{ repo: string; issue: number }> = [];
    const stateGateway = makeRoutingStateGateway({
      db,
      resolveRepoPath: () => repoRoot,
      ghState: {
        async readBody(repo, issueNumber) {
          readArgs.push({ repo, issue: issueNumber });
          return renderStateIssue({
            version: 1,
            generated: "2026-06-03T00:00:00.000Z",
            runId: "abcd1234",
            intervalMinutes: 15,
            readyToDispatch: [],
            needsHumanInput: [],
            blocked: [],
            inFlight: [],
            excluded: [],
            rateLimits: { claude: "AVAILABLE", codex: "AVAILABLE", github: "UNKNOWN" },
            slotUsage: {
              adapters: [{ adapter: "claude", used: 0, max: 2 }],
              total: { used: 0, max: 3 },
              global: { used: 0, max: 4 },
            },
          });
        },
        async writeBody() {},
      },
    });

    await readState(stateGateway, ghRepo, 42);
    expect(readArgs).toEqual([{ repo: ghRepo, issue: 42 }]);
  });
});
