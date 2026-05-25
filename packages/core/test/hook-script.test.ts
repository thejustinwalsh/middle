import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PR_READY_GATE_SH } from "../src/hook-script.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-sh-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run PR_READY_GATE_SH with a fake `curl` (script body) ahead on PATH; return its exit code. */
async function runGate(fakeCurl: string): Promise<number> {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const scriptPath = join(dir, "gate.sh");
  writeFileSync(scriptPath, PR_READY_GATE_SH);
  const curlPath = join(bin, "curl");
  writeFileSync(curlPath, fakeCurl);
  chmodSync(curlPath, 0o755);
  const proc = Bun.spawn(["sh", scriptPath], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      MIDDLE_DISPATCHER_URL: "http://127.0.0.1:9",
      MIDDLE_SESSION: "s",
      MIDDLE_SESSION_TOKEN: "t",
      MIDDLE_EPIC: "1",
    },
    stdin: new TextEncoder().encode("{}"),
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
}

describe("PR_READY_GATE_SH exit-code contract", () => {
  test("HTTP 200 → exit 0 (allow)", async () => {
    expect(await runGate("#!/bin/sh\nprintf 200\n")).toBe(0);
  });

  test("curl failure emitting no http code → exit 0 (fails OPEN, not closed)", async () => {
    // DNS/connect failure: curl exits non-zero and prints nothing, so CODE is
    // empty. Without the empty→000 normalization this hit the `*` deny branch
    // and wedged the agent (exit 2). It must fail open.
    expect(await runGate("#!/bin/sh\nexit 7\n")).toBe(0);
  });

  test("HTTP 403 from a reachable dispatcher → exit 2 (blocks)", async () => {
    expect(await runGate("#!/bin/sh\nprintf 403\n")).toBe(2);
  });

  test("HTTP 404 (no gate wired — e.g. a recommender/docs session) → exit 0 (allow, never wedge)", async () => {
    // The recommender/docs hook servers have no /gates/pr-ready route, so the
    // POST 404s. A 404 is NOT a deny — only an explicit 403 is. This is the bug
    // that blocked every Bash call in a recommender session ("not found" was the
    // 404 body relayed as the deny reason).
    expect(await runGate("#!/bin/sh\nprintf 404\n")).toBe(0);
  });

  test("HTTP 500 (dispatcher hiccup) → exit 0 (fails open, only 403 blocks)", async () => {
    expect(await runGate("#!/bin/sh\nprintf 500\n")).toBe(0);
  });
});
