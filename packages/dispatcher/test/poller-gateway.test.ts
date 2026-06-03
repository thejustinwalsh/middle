import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckRollupEntry, deriveCiStatus, ghPollGateway } from "../src/poller-gateway.ts";

/** A finished GitHub Actions check run. */
function run(conclusion: string): CheckRollupEntry {
  return { status: "COMPLETED", conclusion };
}

describe("deriveCiStatus", () => {
  test("no checks configured → none (nothing to gate on)", () => {
    expect(deriveCiStatus(null)).toBe("none");
    expect(deriveCiStatus([])).toBe("none");
  });

  test("all check runs succeeded (incl. neutral/skipped) → passing", () => {
    expect(deriveCiStatus([run("SUCCESS"), run("NEUTRAL"), run("SKIPPED")])).toBe("passing");
  });

  test("any failed/errored/cancelled/timed-out check → failing", () => {
    expect(deriveCiStatus([run("SUCCESS"), run("FAILURE")])).toBe("failing");
    expect(deriveCiStatus([run("TIMED_OUT")])).toBe("failing");
    expect(deriveCiStatus([run("CANCELLED")])).toBe("failing");
    expect(deriveCiStatus([run("ACTION_REQUIRED")])).toBe("failing");
  });

  test("an unfinished check run (not COMPLETED) → pending", () => {
    expect(deriveCiStatus([run("SUCCESS"), { status: "IN_PROGRESS" }])).toBe("pending");
    expect(deriveCiStatus([{ status: "QUEUED" }])).toBe("pending");
  });

  test("a failure outranks a still-running check → failing", () => {
    expect(deriveCiStatus([{ status: "IN_PROGRESS" }, run("FAILURE")])).toBe("failing");
  });

  test("legacy StatusContext entries (state) are read too", () => {
    expect(deriveCiStatus([{ state: "SUCCESS" }])).toBe("passing");
    expect(deriveCiStatus([{ state: "PENDING" }])).toBe("pending");
    expect(deriveCiStatus([{ state: "FAILURE" }])).toBe("failing");
    expect(deriveCiStatus([{ state: "ERROR" }])).toBe("failing");
  });

  test("EXPECTED is pending, not passing — a green gate requires an actual SUCCESS", () => {
    expect(deriveCiStatus([{ state: "EXPECTED" }])).toBe("pending");
    // SUCCESS alongside an EXPECTED is still pending overall (not all final)
    expect(deriveCiStatus([{ state: "SUCCESS" }, { state: "EXPECTED" }])).toBe("pending");
  });
});

// A fake `gh` on PATH lets us exercise the per-fetch failure-isolation contract
// without a live GitHub. The script's `reviews` branch fails when
// FAKE_GH_REVIEWS_FAIL is set, so we can drive "pr view succeeds, reviews fetch
// throws" — the exact split the snapshot fetcher must isolate.
describe("ghPollGateway.prSnapshot failure isolation", () => {
  let binDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "middle-fakegh-"));
    const script = [
      "#!/bin/sh",
      'case "$*" in',
      "  *reviews*)",
      '    if [ -n "$FAKE_GH_REVIEWS_FAIL" ]; then echo "simulated reviews failure" >&2; exit 1; fi',
      "    echo '[[]]'",
      "    ;;",
      "  *reviewDecision*)",
      '    if [ -n "$FAKE_GH_VIEW_FAIL" ]; then echo "simulated pr-view failure" >&2; exit 1; fi',
      `    echo '{"reviewDecision":"APPROVED","labels":[{"name":"ready-for-review"}],"statusCheckRollup":[]}'`,
      "    ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n");
    writeFileSync(join(binDir, "gh"), script);
    chmodSync(join(binDir, "gh"), 0o755);
    origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath ?? ""}`;
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    delete process.env.FAKE_GH_REVIEWS_FAIL;
    delete process.env.FAKE_GH_VIEW_FAIL;
    rmSync(binDir, { recursive: true, force: true });
  });

  test("a transient reviews-fetch failure degrades to null, not a thrown pass", async () => {
    process.env.FAKE_GH_REVIEWS_FAIL = "1";
    // `pr view` succeeds but the reviews API call throws — must isolate to null,
    // mirroring the `pr view` failure path, so one workflow's transient error
    // never aborts the whole poll pass.
    expect(await ghPollGateway.prSnapshot("o/r", 42)).toBeNull();
  });

  test("a `pr view` failure also degrades to null (the symmetric branch)", async () => {
    process.env.FAKE_GH_VIEW_FAIL = "1";
    expect(await ghPollGateway.prSnapshot("o/r", 42)).toBeNull();
  });

  test("both fetches succeed → a populated snapshot", async () => {
    const snap = await ghPollGateway.prSnapshot("o/r", 42);
    expect(snap).toMatchObject({ number: 42, reviewDecision: "APPROVED", reviews: [] });
    expect(snap?.labels).toEqual(["ready-for-review"]);
  });
});
