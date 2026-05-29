import { describe, expect, spyOn, test } from "bun:test";
import type { RetentionStatus } from "@middle/dispatcher/src/retention.ts";
import { formatAgo, runDoctor, summarizeRetention } from "../src/commands/doctor.ts";

// runDoctor shells out to bun/tmux/claude/git/gh — these all exist on the
// machine middle is built for, so the happy path is verifiable. We don't fake
// out missing binaries here (that's interactive operator territory); the unit
// behavior of the version checks is covered by the tmux helpers' unit tests.
// The config/dispatcher/database checks degrade to pass-or-warn off the happy
// path (no config → defaults; no daemon → "not running"; no db → "not created"),
// never fail, so the run still returns 0; their formatting logic is unit-tested
// below against fabricated inputs.

describe("runDoctor — happy path", () => {
  test("returns 0 and prints every check when the toolchain is healthy", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = await runDoctor();
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("middle — system check");
    for (const name of [
      "bun",
      "tmux",
      "claude",
      "git",
      "gh",
      "gh auth",
      "config",
      "dispatcher",
      "state-issue",
      "database",
      "skills",
      "docs",
      "tsdoc",
    ]) {
      expect(output).toContain(name);
    }
  });
});

describe("formatAgo", () => {
  const now = 1_000_000_000_000;
  test("renders sub-minute as seconds", () => {
    expect(formatAgo(now - 5_000, now)).toBe("5s ago");
  });
  test("renders minutes, hours, and days at the boundaries", () => {
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
  test("clamps a future timestamp to 0s (never negative)", () => {
    expect(formatAgo(now + 10_000, now)).toBe("0s ago");
  });
});

describe("summarizeRetention", () => {
  const now = 1_000_000_000_000;
  const counts: RetentionStatus["rowCounts"] = { workflows: 12, archivedWorkflows: 3, events: 40 };

  test("never-run → pass, reports counts", () => {
    const r = summarizeRetention({ rowCounts: counts, lastRun: null }, now);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("12 workflows (3 archived), 40 events");
    expect(r.detail).toContain("retention never run");
  });

  test("clean last run → pass, reports the run", () => {
    const r = summarizeRetention(
      {
        rowCounts: counts,
        lastRun: {
          id: 1,
          ranAt: now - 3_600_000,
          eventsDeleted: 7,
          workflowsArchived: 2,
          ok: true,
          detail: null,
        },
      },
      now,
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("retention ok 1h ago (−7 events, 2 archived)");
  });

  test("failed last run → warn, surfaces FAILED", () => {
    const r = summarizeRetention(
      {
        rowCounts: counts,
        lastRun: {
          id: 2,
          ranAt: now - 60_000,
          eventsDeleted: 0,
          workflowsArchived: 0,
          ok: false,
          detail: "disk full",
        },
      },
      now,
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("retention FAILED 1m ago");
  });
});
