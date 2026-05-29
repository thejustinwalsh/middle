import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type MiddleConfig } from "@middle/core";
import { currentSchemaVersion, openDb } from "@middle/dispatcher/src/db.ts";
import { collectRetentionStatus, type RetentionStatus } from "@middle/dispatcher/src/retention.ts";
import {
  getTmuxVersion,
  MIN_TMUX_VERSION,
  tmuxVersionAtLeast,
} from "@middle/dispatcher/src/tmux.ts";
import { defaultPidFile } from "../paths.ts";
import {
  BOOTSTRAP_SKILLS_DIR,
  CANONICAL_SKILLS_DIR,
  diffSkills,
} from "../bootstrap/skills-sync.ts";
import {
  applyPathFix,
  bunPathSnippet,
  getBunGlobalBinDir,
  isDirOnPath,
  resolveShellRc,
} from "../checks/bun-path.ts";
import { checkModuleIndex } from "../checks/module-index.ts";
import { checkStateIssue } from "../checks/state-issue.ts";
import { checkTsdocCoverage } from "../checks/tsdoc-coverage.ts";

/** Schema version migration 006 (retention) brings the db to — `mm doctor`
 * reports retention status only once the db is at least here. */
const RETENTION_SCHEMA_VERSION = 6;

type CheckStatus = "pass" | "warn" | "fail";
type Check = { name: string; status: CheckStatus; detail: string };

const STATUS_ICON: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };

async function runCommand(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

async function checkTmux(): Promise<Check> {
  const version = await getTmuxVersion();
  if (!version) {
    return { name: "tmux", status: "fail", detail: "not installed (not on PATH)" };
  }
  if (!tmuxVersionAtLeast(version, MIN_TMUX_VERSION)) {
    return {
      name: "tmux",
      status: "warn",
      detail: `${version.raw} — extended-keys-format needs ≥ ${MIN_TMUX_VERSION.raw}; agent interactivity degraded`,
    };
  }
  return { name: "tmux", status: "pass", detail: version.raw };
}

async function checkBinary(
  name: string,
  argv: string[],
  parseDetail: (stdout: string) => string = (out) => out.split("\n")[0]!.trim(),
): Promise<Check> {
  if (!Bun.which(argv[0]!)) {
    return { name, status: "fail", detail: `${argv[0]} not installed (not on PATH)` };
  }
  const result = await runCommand(argv);
  if (result.exitCode !== 0) {
    return {
      name,
      status: "fail",
      detail: `\`${argv.join(" ")}\` exited ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }
  return { name, status: "pass", detail: parseDetail(result.stdout) };
}

/**
 * Flag when Bun's global bin dir (where `bun link` drops the `mm` symlink) is
 * not on `$PATH`. A **warning**, not a fail: `mm` is still runnable via
 * `bun run mm`. The motivating case is a Homebrew Bun install, which never adds
 * `~/.bun/bin` to the shell rc the way the `curl | bash` installer does.
 */
async function checkBunPath(): Promise<Check> {
  const binDir = await getBunGlobalBinDir();
  if (isDirOnPath(binDir, process.env.PATH ?? "")) {
    return { name: "bun PATH", status: "pass", detail: `${binDir} on PATH` };
  }
  return {
    name: "bun PATH",
    status: "warn",
    detail: `${binDir} not on PATH — globally-linked binaries like \`mm\` are invisible; run \`mm doctor --fix\``,
  };
}

/**
 * `mm doctor --fix` action: if Bun's global bin dir is off `$PATH`, append the
 * PATH export to the active shell's rc (`$SHELL` → `~/.zshrc` / `~/.bashrc`).
 * Prints manual instructions when the shell is unrecognized; a no-op otherwise.
 */
async function runBunPathFix(): Promise<void> {
  const binDir = await getBunGlobalBinDir();
  if (isDirOnPath(binDir, process.env.PATH ?? "")) {
    console.log("--fix: bun PATH already correct — nothing to fix.");
    return;
  }
  const home = homedir();
  const snippet = bunPathSnippet(binDir, home);
  const rc = resolveShellRc(process.env.SHELL, home, process.platform);
  if ("unknown" in rc) {
    console.log(
      `--fix: couldn't detect your shell from $SHELL. Add this to your shell rc (~/.zshrc or ~/.bashrc):\n\n${snippet}\n`,
    );
    return;
  }
  const { changed } = applyPathFix({ rcPath: rc.rcPath, snippet, binDir });
  if (changed) {
    console.log(
      `--fix: added bun PATH export to ${rc.rcPath} — run \`source ${rc.rcPath}\` or open a new shell.`,
    );
  } else {
    console.log(`--fix: ${rc.rcPath} already configured — open a new shell to pick it up.`);
  }
}

async function checkGhAuth(): Promise<Check> {
  if (!Bun.which("gh")) {
    return { name: "gh auth", status: "fail", detail: "gh not installed" };
  }
  const result = await runCommand(["gh", "auth", "status"]);
  if (result.exitCode !== 0) {
    return {
      name: "gh auth",
      status: "fail",
      detail: "not authenticated — run `gh auth login`",
    };
  }
  // gh auth status writes its summary to stderr
  const summary =
    (result.stderr.trim() || result.stdout.trim())
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("✓") || line.includes("Logged in")) ?? "authenticated";
  return { name: "gh auth", status: "pass", detail: summary };
}

/**
 * Flag drift between the canonical `packages/skills/` and the
 * `bootstrap-assets/skills/` mirror that `mm init` stamps. The pre-commit hook
 * is the hard enforcement; here it's a warning so a stale mirror is visible to
 * an operator without blocking `mm dispatch` on a tooling precondition.
 */
function checkSkillsDrift(): Check {
  const { inSync, changed } = diffSkills({
    canonicalDir: CANONICAL_SKILLS_DIR,
    mirrorDir: BOOTSTRAP_SKILLS_DIR,
  });
  if (inSync) return { name: "skills", status: "pass", detail: "bootstrap mirror in sync" };
  return {
    name: "skills",
    status: "warn",
    detail: `${changed.length} file(s) drifted from packages/skills/ — run \`bun run sync-skills\``,
  };
}

/**
 * Flag any `src/index.ts(x)` whose module-index frontmatter is malformed or
 * whose `claude-md` flag disagrees with its nested `CLAUDE.md` presence. Like
 * the skills-drift check this is a warning here — the hard gate is the
 * `bun test` suite (CI) — so a doc-convention lapse is visible to an operator
 * without blocking `mm dispatch`.
 */
function checkModuleIndexFrontmatter(): Check {
  const { violations } = checkModuleIndex();
  if (violations.length === 0) {
    return {
      name: "docs",
      status: "pass",
      detail: "module-index frontmatter present + consistent",
    };
  }
  return {
    name: "docs",
    status: "warn",
    detail: `${violations.length} module-index issue(s): ${violations[0]!.file} — ${violations[0]!.message}`,
  };
}

/**
 * Report public exports that lack a doc comment. **Advisory** (always a warn,
 * never a fail) — the gated doc guarantee is `@packageDocumentation` presence
 * (the module-index check); this is an honest backlog signal that shrinks as
 * agents add TSDoc.
 */
function checkTsdocCoverageWarn(): Check {
  const { totalExports, undocumented } = checkTsdocCoverage();
  if (undocumented.length === 0) {
    return { name: "tsdoc", status: "pass", detail: `${totalExports} public exports documented` };
  }
  return {
    name: "tsdoc",
    status: "warn",
    detail: `${undocumented.length}/${totalExports} public exports lack a doc comment (advisory)`,
  };
}

/**
 * Load middle's config (global, plus the cwd's `.middle/config.toml` when the
 * operator runs `mm doctor` from inside a managed repo) and report whether it
 * parses. A malformed TOML throws out of `loadConfig` — that's a hard fail (the
 * dispatcher can't start). The parsed config is handed to the downstream
 * dispatcher/database checks so they read the operator's real port and db path.
 */
function loadDoctorConfig(): { check: Check; config: MiddleConfig | null } {
  const globalPath = process.env.MIDDLE_CONFIG ?? join(homedir(), ".middle", "config.toml");
  const repoConfigPath = join(process.cwd(), ".middle", "config.toml");
  const hasRepoConfig = existsSync(repoConfigPath);
  try {
    const config = loadConfig({
      globalPath: process.env.MIDDLE_CONFIG,
      repoPath: hasRepoConfig ? repoConfigPath : undefined,
    });
    const sources = [existsSync(globalPath) ? globalPath : `${globalPath} (defaults)`];
    if (hasRepoConfig) sources.push(repoConfigPath);
    return {
      check: { name: "config", status: "pass", detail: `parsed — ${sources.join(", ")}` },
      config,
    };
  } catch (error) {
    return {
      check: {
        name: "config",
        status: "fail",
        detail: `failed to parse — ${(error as Error).message}`,
      },
      config: null,
    };
  }
}

/** Is the pid recorded in the pidfile a live process? Best-effort (`kill -0`). */
function dispatcherPidAlive(): boolean {
  const pidFile = defaultPidFile();
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Probe the dispatcher's `/health` endpoint with a short timeout. */
async function probeHealth(port: number): Promise<{ ok: boolean; version: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, version: "" };
    const body = (await res.json().catch(() => null)) as { ok?: unknown; version?: unknown } | null;
    return {
      ok: body?.ok === true,
      version: typeof body?.version === "string" ? body.version : "",
    };
  } catch {
    return { ok: false, version: "" };
  }
}

/**
 * Check the dispatcher is reachable. Reachable `/health` → pass. A live pidfile
 * but an unreachable `/health` → **fail** (the daemon is wedged). No pidfile /
 * dead process → **warn**: the dispatcher simply isn't started, which is normal
 * when an operator runs `mm doctor` before `mm start`.
 */
async function checkDispatcher(config: MiddleConfig | null): Promise<Check> {
  const port = config?.global.dispatcherPort ?? 4120;
  const health = await probeHealth(port);
  if (health.ok) {
    const v = health.version ? ` (v${health.version})` : "";
    return { name: "dispatcher", status: "pass", detail: `reachable on :${port}${v}` };
  }
  if (dispatcherPidAlive()) {
    return {
      name: "dispatcher",
      status: "fail",
      detail: `pidfile live but /health on :${port} unreachable — dispatcher may be wedged`,
    };
  }
  return { name: "dispatcher", status: "warn", detail: `not running — run \`mm start\`` };
}

/** Render a unix-ms timestamp as a coarse "Ns/Nm/Nh/Nd ago" relative to `now`. */
export function formatAgo(then: number, now: number): string {
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * Format the db row counts + last retention run into a doctor detail line, and
 * decide the status: a *failed* last retention run degrades to `warn` (retention
 * is broken but dispatch still works); otherwise `pass`. Pure so it unit-tests
 * without a real db.
 */
export function summarizeRetention(
  status: RetentionStatus,
  now: number,
): { status: CheckStatus; detail: string } {
  const { workflows, archivedWorkflows, events } = status.rowCounts;
  const counts = `${workflows} workflows (${archivedWorkflows} archived), ${events} events`;
  const last = status.lastRun;
  if (!last) {
    return { status: "pass", detail: `${counts} · retention never run` };
  }
  const verdict = last.ok ? "ok" : "FAILED";
  const retention = `retention ${verdict} ${formatAgo(last.ranAt, now)} (−${last.eventsDeleted} events, ${last.workflowsArchived} archived)`;
  return { status: last.ok ? "pass" : "warn", detail: `${counts} · ${retention}` };
}

/**
 * Report SQLite row counts and recent retention-run status. No db file yet
 * (dispatcher never started) → `warn`. A db below the retention schema version →
 * `warn` (start the dispatcher to migrate). A db that can't be opened → `fail`.
 */
function checkDatabase(config: MiddleConfig | null): Check {
  const dbPath = config?.global.dbPath ?? join(homedir(), ".middle", "db.sqlite3");
  if (!existsSync(dbPath)) {
    return {
      name: "database",
      status: "warn",
      detail: `${dbPath} not created yet — run \`mm start\` once`,
    };
  }
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(dbPath);
    const version = currentSchemaVersion(db);
    if (version < RETENTION_SCHEMA_VERSION) {
      return {
        name: "database",
        status: "warn",
        detail: `schema v${version} (pre-retention, needs ≥ v${RETENTION_SCHEMA_VERSION}) — run \`mm start\` to migrate`,
      };
    }
    const summary = summarizeRetention(collectRetentionStatus(db), Date.now());
    return { name: "database", status: summary.status, detail: summary.detail };
  } catch (error) {
    return {
      name: "database",
      status: "fail",
      detail: `cannot read ${dbPath} — ${(error as Error).message}`,
    };
  } finally {
    db?.close();
  }
}

/**
 * `mm doctor` — full operator health check. Validates the toolchain every
 * dispatch shells out to (`bun`, `tmux` ≥ 3.5, `claude`, `git`, `gh` + auth),
 * that config parses, the dispatcher is reachable, the state-issue parser still
 * round-trips against its v1 schema, and reports SQLite row counts + recent
 * retention status — plus the repo's skills/docs-convention drift warnings.
 * Exits 0 when no check fails; 1 if anything is missing or broken. Warnings
 * (degraded but functional) do not fail the run.
 */
export async function runDoctor({ fix }: { fix?: boolean } = {}): Promise<number> {
  const { check: configCheck, config } = loadDoctorConfig();
  const stateIssue = checkStateIssue();
  const checks: Check[] = [
    await checkBinary("bun", ["bun", "--version"]),
    await checkBunPath(),
    await checkTmux(),
    await checkBinary("claude", ["claude", "--version"]),
    await checkBinary("git", ["git", "--version"]),
    await checkBinary("gh", ["gh", "--version"]),
    await checkGhAuth(),
    configCheck,
    await checkDispatcher(config),
    { name: "state-issue", status: stateIssue.status, detail: stateIssue.detail },
    checkDatabase(config),
    checkSkillsDrift(),
    checkModuleIndexFrontmatter(),
    checkTsdocCoverageWarn(),
  ];

  console.log("middle — system check\n");
  for (const c of checks) {
    console.log(`  ${STATUS_ICON[c.status]} ${c.name.padEnd(11)} ${c.detail}`);
  }
  console.log("");

  if (fix) {
    await runBunPathFix();
    console.log("");
  }

  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");

  if (fails.length > 0) {
    console.log(`${fails.length} blocking issue(s) — fix before running \`mm dispatch\`.`);
    return 1;
  }
  if (warns.length > 0) {
    console.log(`${warns.length} warning(s) — mm will run, but something is degraded (see above).`);
    return 0;
  }
  console.log("all checks pass.");
  return 0;
}
