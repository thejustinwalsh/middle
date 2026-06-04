import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig, MiddleConfig } from "@middle/core";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { setEpicStoreConfig } from "@middle/dispatcher/src/repo-config.ts";
import { EPIC_DOC_MARKER } from "@middle/dispatcher/src/epic-store/epic-file/markers.ts";
import { parseEpicFile } from "@middle/dispatcher/src/epic-store/epic-file/parser.ts";
import { renderEpicFile } from "@middle/dispatcher/src/epic-store/epic-file/renderer.ts";
import type { RetentionStatus } from "@middle/dispatcher/src/retention.ts";
import { renderEmptyStateBody } from "../src/bootstrap/file-store.ts";
import {
  checkAdapterBinaries,
  checkPlaywrightBrowser,
  defaultPlaywrightBrowsersDir,
  formatAgo,
  runDoctor,
  runVocabularyCheck,
  summarizeRetention,
} from "../src/commands/doctor.ts";

/** Build a vocabulary.md body whose `### `<label>`` sections are exactly `labels`. */
function vocabularyDocWith(labels: readonly string[]): string {
  return `# Label vocabulary\n\n${labels.map((l) => `### \`${l}\`\n\n- **Means:** ${l}.\n`).join("\n")}`;
}

/** The full canonical vocabulary the real doc documents — kept in step with `REQUIRED_VOCABULARY`. */
const ALL_LABELS = [
  "epic",
  "approved",
  "needs-design",
  "blocked",
  "wontfix",
  "agent:claude",
  "agent:codex",
  "agent-queue:state",
  "agent-queue:eligible",
  "dogfood",
  "bootstrap",
  "housekeeping",
  "phase:N",
];

/** Repo root, resolved from this test file (packages/cli/test → three up). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Pull the first fenced code block out of `markdown` whose body opens with
 * `firstLine`. Used to lift the worked-example Epic file straight from
 * `docs/operator.md` so the doctor fixture IS the documented example — edit the
 * doc into something that no longer parses and this test fails.
 */
function fencedBlockStartingWith(markdown: string, firstLine: string): string | null {
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip the closing fence
      if (body[0] === firstLine) return `${body.join("\n")}\n`;
      continue;
    }
    i += 1;
  }
  return null;
}

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

  // Integration (sub-issue #216): `mm doctor` against a file-mode repo laid out
  // exactly as docs/operator.md's "Enable file mode on an existing repo"
  // walkthrough specifies — the documented `[epic_store]` paths, a `state_file`,
  // and the doc's own worked-example Epic file as the fixture — boots the CLI,
  // runs the three file-mode checks (epics_dir, state_file, Epic-file round-trip),
  // and exits 0. The Epic body is lifted from the doc itself, so an edit that
  // breaks the example (or drops the section) fails here.
  test("doctor honors the documented file-mode config", async () => {
    const operatorDoc = readFileSync(join(REPO_ROOT, "docs", "operator.md"), "utf8");
    const epicBody = fencedBlockStartingWith(operatorDoc, EPIC_DOC_MARKER);
    expect(epicBody, "operator.md must carry a worked-example Epic file").not.toBeNull();
    // The documented example must itself be a valid, round-tripping Epic file.
    expect(renderEpicFile(parseEpicFile(epicBody!))).toBe(epicBody!);
    const slug = parseEpicFile(epicBody!).meta.slug;

    // Lay out the repo exactly as the walkthrough describes.
    mkdirSync(join(tmp, "planning", "epics"), { recursive: true });
    mkdirSync(join(tmp, ".middle"), { recursive: true });
    writeFileSync(join(tmp, "planning", "epics", `${slug}.md`), epicBody!);
    writeFileSync(join(tmp, ".middle", "state.md"), renderEmptyStateBody(new Date()));
    setMode({ mode: "file", epicsDir: "planning/epics", stateFile: ".middle/state.md" });

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = await runDoctor({ repoPath: tmp, resolveSlug: async () => SLUG });
    } finally {
      spy.mockRestore();
    }
    const output = lines.join("\n");

    expect(output).toContain("✓ epics_dir   planning/epics exists");
    expect(output).toContain("✓ state_file  .middle/state.md present");
    expect(output).toContain("✓ epic-files  1 Epic file(s) round-trip");
    expect(output).not.toContain("state-issue");
    expect(code).toBe(0);
  });

  // A malformed Epic file under epics_dir fails the round-trip check (and the run).
  test("file mode + malformed Epic file → epic-files fail", async () => {
    mkdirSync(join(tmp, "planning", "epics"), { recursive: true });
    mkdirSync(join(tmp, ".middle"), { recursive: true });
    // Opens with the Epic doc marker (so it's treated as an Epic) but is missing
    // the required H1/meta — the parser throws, doctor surfaces it by filename.
    writeFileSync(join(tmp, "planning", "epics", "broken.md"), `${EPIC_DOC_MARKER}\nnot an epic\n`);
    writeFileSync(join(tmp, ".middle", "state.md"), renderEmptyStateBody(new Date()));
    setMode({ mode: "file", epicsDir: "planning/epics", stateFile: ".middle/state.md" });

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = await runDoctor({ repoPath: tmp, resolveSlug: async () => SLUG });
    } finally {
      spy.mockRestore();
    }
    const output = lines.join("\n");
    expect(output).toContain("✗ epic-files");
    expect(output).toContain("broken.md malformed");
    expect(code).toBe(1);
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

describe("runVocabularyCheck — docs↔code label drift guard (#217)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mm-vocab-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const runOn = (doc: string): { code: number; output: string } => {
    const path = join(tmp, "vocabulary.md");
    writeFileSync(path, doc);
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = runVocabularyCheck({ vocabularyDocPath: path });
    } finally {
      spy.mockRestore();
    }
    return { code, output: lines.join("\n") };
  };

  test("complete doc → exit 0, lists every documented label", () => {
    const { code, output } = runOn(vocabularyDocWith(ALL_LABELS));
    expect(code).toBe(0);
    expect(output).toContain("docs and code agree");
    for (const l of ALL_LABELS) expect(output).toContain(l);
  });

  test("missing a code-keyed label → exit 1, names the code disagreement", () => {
    // Drop `needs-design` (the NEEDS_DESIGN_LABEL constant the audit/recommender key on).
    const { code, output } = runOn(
      vocabularyDocWith(ALL_LABELS.filter((l) => l !== "needs-design")),
    );
    expect(code).toBe(1);
    expect(output).toContain("code keys on `needs-design`");
  });

  test("missing a code-keyed internals label → exit 1", () => {
    // Drop `agent-queue:state` (the STATE_LABEL constant).
    const { code, output } = runOn(
      vocabularyDocWith(ALL_LABELS.filter((l) => l !== "agent-queue:state")),
    );
    expect(code).toBe(1);
    expect(output).toContain("code keys on `agent-queue:state`");
  });

  test("missing a required-but-not-code-keyed label → exit 1 (deleted section caught)", () => {
    // `phase:N` is grouping metadata code doesn't key on — completeness still requires it.
    const { code, output } = runOn(vocabularyDocWith(ALL_LABELS.filter((l) => l !== "phase:N")));
    expect(code).toBe(1);
    expect(output).toContain("missing required label `phase:N`");
  });

  test("missing doc file → exit 1", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    let code: number;
    try {
      code = runVocabularyCheck({ vocabularyDocPath: join(tmp, "nope.md") });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("not found");
  });

  // Integration: boot the real `mm` CLI against the real docs/vocabulary.md and
  // require agreement. This is the wired path the operator runs — `mm doctor
  // --vocabulary-check` — and it must exit 0 in a healthy tree, proving the
  // shipped doc and the shipped label constants agree right now.
  test("`mm doctor --vocabulary-check` boots the CLI and exits 0 against the shipped doc", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "packages", "cli", "src", "index.ts"),
        "doctor",
        "--vocabulary-check",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toContain("middle — vocabulary check");
    expect(stdout).toContain("docs and code agree");
    expect(code).toBe(0);
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
