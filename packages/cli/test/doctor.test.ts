import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig, MiddleConfig } from "@middle/core";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { setEpicStoreConfig } from "@middle/dispatcher/src/repo-config.ts";
import type { RetentionStatus } from "@middle/dispatcher/src/retention.ts";
import {
  checkAdapterBinaries,
  checkPlaywrightBrowser,
  defaultPlaywrightBrowsersDir,
  formatAgo,
  runDoctor,
  summarizeRetention,
} from "../src/commands/doctor.ts";

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

describe("runDoctor — mode-aware Epic-store check", () => {
  const SLUG = "acme/widgets";
  let tmp: string;
  let prevMiddleConfig: string | undefined;

  // Seed a migrated db pointed at by a temp global config, so loadDoctorConfig
  // resolves db_path → our db and resolveEpicStore reads the row we set. The
  // repo slug is injected (resolveSlug) so no git remote is consulted.
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mm-doctor-"));
    const dbPath = join(tmp, "db.sqlite3");
    openAndMigrate(dbPath).close();
    const configPath = join(tmp, "config.toml");
    writeFileSync(configPath, `[global]\ndb_path = "${dbPath}"\n`);
    prevMiddleConfig = process.env.MIDDLE_CONFIG;
    process.env.MIDDLE_CONFIG = configPath;
  });

  afterEach(() => {
    if (prevMiddleConfig === undefined) delete process.env.MIDDLE_CONFIG;
    else process.env.MIDDLE_CONFIG = prevMiddleConfig;
    rmSync(tmp, { recursive: true, force: true });
  });

  const setMode = (cfg: Parameters<typeof setEpicStoreConfig>[2]) => {
    const db = openAndMigrate(join(tmp, "db.sqlite3"));
    try {
      setEpicStoreConfig(db, SLUG, cfg);
    } finally {
      db.close();
    }
  };

  const run = async (repoPath: string): Promise<string> => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await runDoctor({ repoPath, resolveSlug: async () => SLUG });
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  };

  test("file mode + existing epics dir → epics_dir pass, no state-issue row", async () => {
    mkdirSync(join(tmp, "planning", "epics"), { recursive: true });
    setMode({ mode: "file", epicsDir: "planning/epics", stateFile: ".middle/state.md" });

    const output = await run(tmp);
    expect(output).toContain("✓ epics_dir   planning/epics exists");
    expect(output).not.toContain("state-issue");
  });

  test("file mode + missing epics dir → epics_dir fail, no state-issue row", async () => {
    setMode({ mode: "file", epicsDir: "planning/epics", stateFile: ".middle/state.md" });

    const output = await run(tmp);
    expect(output).toContain("✗ epics_dir");
    expect(output).toContain("planning/epics missing");
    expect(output).toContain("mm init --epic-store=file");
    expect(output).not.toContain("state-issue");
  });

  test("github mode (no config row) → state-issue row, no epics_dir row", async () => {
    const output = await run(tmp);
    expect(output).toContain("state-issue");
    expect(output).not.toContain("epics_dir");
  });
});

describe("checkAdapterBinaries", () => {
  const adapter = (enabled: boolean, binary: string): AdapterConfig => ({
    enabled,
    binary,
    extraArgs: [],
  });
  const withAdapters = (adapters: Record<string, AdapterConfig>): MiddleConfig =>
    ({ adapters }) as MiddleConfig;

  test("null config (unparseable) → single warn, no throw", async () => {
    expect(await checkAdapterBinaries(null)).toEqual([
      { name: "adapters", status: "warn", detail: "config unreadable — adapter checks skipped" },
    ]);
  });

  test("no enabled adapters → warn", async () => {
    expect(await checkAdapterBinaries(withAdapters({}))).toEqual([
      { name: "adapters", status: "warn", detail: "no adapters enabled in config" },
    ]);
  });

  test("reports a row per ENABLED adapter from the passed config — not a reloaded global one", async () => {
    // `bun` is the runtime, so it's always on PATH: an adapter whose binary is
    // `bun` reliably passes, proving the rows came from THIS config object (the
    // repo-aware one runDoctor resolved) rather than a reloaded global default.
    const checks = await checkAdapterBinaries(
      withAdapters({
        repoonly: adapter(true, "bun"),
        disabled: adapter(false, "bun"),
      }),
    );
    expect(checks.map((c) => c.name)).toEqual(["repoonly"]);
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.detail).toContain("on PATH");
  });

  test("enabled adapter with a missing binary → warn (never fail)", async () => {
    const checks = await checkAdapterBinaries(
      withAdapters({ ghost: adapter(true, "middle-no-such-binary-xyz") }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.detail).toContain("not installed");
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

describe("checkPlaywrightBrowser", () => {
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-pw-"));
    process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a chromium install in the browsers cache → pass", () => {
    mkdirSync(join(dir, "chromium_headless_shell-1223"));
    const check = checkPlaywrightBrowser();
    expect(check.status).toBe("pass");
  });

  test("no chromium → warn, documents the install command", () => {
    const check = checkPlaywrightBrowser();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("bunx playwright install chromium");
  });
});

describe("defaultPlaywrightBrowsersDir — OS-specific Playwright cache fallback", () => {
  const home = join("/home", "tester");
  test("linux → ~/.cache/ms-playwright", () => {
    expect(defaultPlaywrightBrowsersDir("linux", home)).toBe(join(home, ".cache", "ms-playwright"));
  });
  test("macOS → ~/Library/Caches/ms-playwright", () => {
    expect(defaultPlaywrightBrowsersDir("darwin", home)).toBe(
      join(home, "Library", "Caches", "ms-playwright"),
    );
  });
  test("windows → ~/AppData/Local/ms-playwright", () => {
    expect(defaultPlaywrightBrowsersDir("win32", home)).toBe(
      join(home, "AppData", "Local", "ms-playwright"),
    );
  });
  test("unknown platforms fall back to the linux layout (no false warning)", () => {
    expect(defaultPlaywrightBrowsersDir("freebsd" as NodeJS.Platform, home)).toBe(
      join(home, ".cache", "ms-playwright"),
    );
  });
});
