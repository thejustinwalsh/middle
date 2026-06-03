/**
 * Scripted file-mode smoke (#194): a file-mode repo is configured + an Epic file
 * authored, then `mm dispatch --epic <slug>` is driven against a daemon that
 * creates the workflow row exactly as the real `/control/dispatch` → engine path
 * does. Asserts the row lands with `epic_ref = <slug>` and that the repo is
 * file-mode through the bootstrap selector (`readEpicStoreConfig`).
 *
 * The daemon's real engine/tmux drive is out of scope here (covered by the
 * dispatcher's `epic-store/file-dispatch-integration.test.ts`); this pins the
 * CLI → control-plane → workflows-table contract for a slug dispatch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { createWorkflowRecord, getWorkflow } from "@middle/dispatcher/src/workflow-record.ts";
import { readEpicStoreConfig, setEpicStoreConfig } from "@middle/dispatcher/src/repo-config.ts";
import { renderEpicFile } from "@middle/dispatcher/src/epic-store/epic-file/renderer.ts";
import { runDispatch } from "../src/commands/dispatch.ts";

type BunServer = ReturnType<typeof Bun.serve>;

let scratch: string;
let repoPath: string;
let db: Database;
let server: BunServer;

const SLUG = "rollout-epic-store";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e.invalid",
    },
  });
  await proc.exited;
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "middle-smoke-"));
  repoPath = join(scratch, "repo");
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  // A managed file-mode repo: db config + an authored Epic file on disk.
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  const slug = "repo"; // deriveRepoSlug falls back to the dir basename without a remote
  setEpicStoreConfig(db, slug, {
    mode: "file",
    epicsDir: "planning/epics",
    stateFile: ".middle/state.md",
  });
  const epicsDir = join(repoPath, "planning", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(
    join(epicsDir, `${SLUG}.md`),
    renderEpicFile({
      title: "feat: rollout",
      meta: { slug: SLUG, adapter: "claude" },
      context: "ctx",
      acceptanceCriteria: [{ checked: false, text: "ship" }],
      subIssues: [{ id: 1, checked: false, title: "1 — gateways", body: "" }],
      conversation: [],
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  db.close();
});

describe("file-mode CLI smoke (#194)", () => {
  test("mm dispatch --epic <slug> lands a workflow row with epic_ref=<slug> (file mode selected)", async () => {
    // The repo is file-mode through the bootstrap selector.
    expect(readEpicStoreConfig(db, "repo").mode).toBe("file");

    // A daemon that creates the workflow row from the posted epicRef — exactly
    // what `/control/dispatch` → `startDispatchImpl` → `createWorkflowRecord` does.
    const configPath = join(scratch, "config.toml");
    let workflowId = "";
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (req.method === "GET" && pathname === "/health") {
          return Response.json({ ok: true, port: 0, version: "test" });
        }
        if (req.method === "POST" && pathname === "/control/dispatch") {
          const body = (await req.json()) as { epicRef: string; adapter: string };
          workflowId = `wf-${body.epicRef}`;
          createWorkflowRecord(db, {
            id: workflowId,
            kind: "implementation",
            repo: "repo",
            epicRef: body.epicRef,
            adapter: body.adapter,
            source: "manual",
          });
          return Response.json({ workflowId });
        }
        if (req.method === "GET" && pathname === "/control/events") {
          const frame = `event: workflow\ndata: ${JSON.stringify({ id: workflowId || `wf-${SLUG}`, state: "completed" })}\n\n`;
          return new Response(frame, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeFileSync(configPath, `[global]\ndispatcher_port = ${server.port}\n`);

    const restoreLog = console.log;
    console.log = () => {};
    try {
      const code = await runDispatch(repoPath, SLUG, { configPath, startDaemon: () => 0 });
      expect(code).toBe(0);
    } finally {
      console.log = restoreLog;
    }

    // The row landed with the slug as epic_ref and a null numeric epic_number.
    const row = getWorkflow(db, `wf-${SLUG}`);
    expect(row?.epicRef).toBe(SLUG);
    expect(row?.epicNumber).toBeNull();
  });
});
