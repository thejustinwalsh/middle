/**
 * `mm verify-file-mode --live --repo <owner/name>` — the real-GitHub smoke: the
 * test the autonomous flow never ran (Epic #208). It drives the full file-mode
 * loop against a **live** GitHub repo — author an Epic file on a fresh branch,
 * dispatch it, satisfy any park by editing the answer block, then assert a draft
 * PR exists with the expected sub-issue checkbox flipped — and cleans up on
 * success / leaves the artifacts (printing their URLs) on failure.
 *
 * This is **not** part of `bun test`: it needs real GitHub, a real agent, real
 * tokens, and minutes of wall-clock, so it is an opt-in operator step on a
 * manual/weekly cadence (see `docs/dogfooding.md`). The orchestration
 * ({@link runLiveSmoke}) is fully unit-tested against an injected {@link LiveSmokeIO};
 * the production IO ({@link makeLiveSmokeIO}) is the GitHub/daemon/git boundary CI
 * cannot exercise — that boundary is the recorded one-shot evidence run.
 */

import { runDispatch } from "./dispatch.ts";

/** An open PR as the smoke needs to reason about it. */
export type LivePr = {
  number: number;
  isDraft: boolean;
  url: string;
};

/** Settled workflow state the smoke distinguishes: a question park vs anything terminal. */
export type SettledState = "completed" | "waiting-human" | "failed";

/**
 * The GitHub/daemon/git boundary the live smoke drives. Every method is a real
 * side-effect against the test repo; the orchestration ({@link runLiveSmoke}) is
 * pure control flow over this seam, so it is unit-tested with a fake IO and the
 * production impl ({@link makeLiveSmokeIO}) is the operator-run boundary.
 */
export type LiveSmokeIO = {
  log: (line: string) => void;
  /** Author the Epic file on a fresh branch in the test repo; returns its slug + branch URL. */
  authorEpic: () => Promise<{ slug: string; branch: string; branchUrl: string }>;
  /** Dispatch the Epic through the daemon and resolve once the row settles. */
  dispatch: (slug: string) => Promise<SettledState>;
  /** Fill in the open question's answer block on disk (the file-mode resume trigger). */
  answerQuestion: (slug: string) => Promise<void>;
  /** Wait for the daemon's file-watcher resume to drive the sub-issue checkbox to `[x]`. */
  awaitResume: (slug: string) => Promise<void>;
  /** The Epic's open draft PR, or null if none opened. */
  findEpicPr: (slug: string) => Promise<LivePr | null>;
  /** Whether sub-issue `id`'s checkbox is `[x]` on the PR head. */
  isSubIssueChecked: (slug: string, pr: LivePr, id: number) => Promise<boolean>;
  /** Tear the test branch + PR down (success only). */
  cleanup: (slug: string, branch: string, pr: LivePr | null) => Promise<void>;
};

/**
 * The live-smoke orchestration. Returns a process exit code (0 green / 1 failed).
 * On success it cleans up; on **any** failure it leaves the surviving branch/PR
 * intact and prints their URLs for operator inspection (never cleans up a
 * failure — the artifacts are the diagnosis).
 */
export async function runLiveSmoke(io: LiveSmokeIO): Promise<number> {
  io.log("authoring an Epic file on a fresh branch in the test repo…");
  const { slug, branch, branchUrl } = await io.authorEpic();
  io.log(`authored Epic '${slug}' on branch '${branch}'`);

  io.log(`dispatching '${slug}' through the daemon…`);
  const settled = await io.dispatch(slug);
  io.log(`workflow settled: ${settled}`);
  if (settled === "failed") {
    io.log(`FAIL: dispatch failed. Surviving branch: ${branchUrl}`);
    return 1;
  }

  if (settled === "waiting-human") {
    io.log("parked — filling in the answer block to satisfy the park…");
    await io.answerQuestion(slug);
    io.log("waiting for the file-watcher resume to complete the sub-issue…");
    await io.awaitResume(slug);
  }

  const pr = await io.findEpicPr(slug);
  if (!pr) {
    io.log(`FAIL: no draft PR opened on the test repo. Surviving branch: ${branchUrl}`);
    return 1;
  }
  if (!pr.isDraft) {
    io.log(`FAIL: PR #${pr.number} is not a draft. Surviving PR: ${pr.url}`);
    return 1;
  }

  const checked = await io.isSubIssueChecked(slug, pr, 1);
  if (!checked) {
    io.log(`FAIL: sub-issue #1 checkbox not flipped on PR #${pr.number}. Surviving PR: ${pr.url}`);
    return 1;
  }

  io.log(`PASS: draft PR #${pr.number} with sub-issue #1 checked — ${pr.url}`);
  await io.cleanup(slug, branch, pr);
  io.log("cleaned up the test branch + PR.");
  return 0;
}

/** Options for {@link runVerifyFileModeLive}. */
export type LiveOptions = {
  /** `owner/name` of the designated throwaway test repo. */
  repo?: string;
  /** Local checkout of the test repo (the daemon dispatches against it). Defaults to cwd. */
  repoPath?: string;
  /** Inject a fake IO (tests only); production builds {@link makeLiveSmokeIO}. */
  io?: LiveSmokeIO;
};

/**
 * Entry point for `mm verify-file-mode --live`. Validates `--repo`, builds the
 * production IO (unless an `io` is injected for tests), and runs the smoke.
 */
export async function runVerifyFileModeLive(opts: LiveOptions = {}): Promise<number> {
  const repo = opts.repo?.trim();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error(
      "mm verify-file-mode --live: pass --repo <owner/name> for the designated test repo",
    );
    return 1;
  }
  const io = opts.io ?? makeLiveSmokeIO({ repo, repoPath: opts.repoPath ?? process.cwd() });
  return runLiveSmoke(io);
}

// ── Production IO — the GitHub/daemon/git boundary (operator-run; not CI-tested) ──

/** Render the throwaway Epic file body for a `--live` run, keyed to `slug` (one sub-issue, one question). */
const EPIC_BODY = (slug: string): string =>
  [
    "<!-- middle:epic v1 -->",
    "# feat: live-smoke verification probe",
    "",
    "## meta",
    `slug: ${slug}`,
    "adapter: claude",
    "",
    "## context",
    "Throwaway Epic authored by `mm verify-file-mode --live` to prove the",
    "file-mode dispatch loop opens a real PR end to end. Safe to delete.",
    "",
    "## acceptance criteria",
    "- [ ] a draft PR opens for this Epic",
    "",
    "## sub-issues",
    "<!-- middle:sub-issue id=1 -->",
    "- [ ] **1 — touch a probe file** Create `verify-live-probe.txt` with any content, open the draft PR, and ask the operator to confirm before finishing.",
    "<!-- /middle:sub-issue -->",
    "",
    "## conversation",
    "",
  ].join("\n");

const ANSWER_TEXT = "Confirmed — finish the sub-issue and leave the PR as a draft.";

/** Run a `gh` subcommand, capturing stdout/stderr; returns `ok` instead of throwing so callers can branch on failure. */
async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout, stderr };
}

/** Run a git subcommand in `cwd`; throws with stderr on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}

/**
 * The real GitHub/daemon/git IO. Operator-run — this boundary is what `bun test`
 * cannot exercise (real repo, real agent, real tokens). The recorded one-shot run
 * against the designated test repo is the evidence; the orchestration above is
 * what CI proves.
 */
export function makeLiveSmokeIO(cfg: { repo: string; repoPath: string }): LiveSmokeIO {
  const { repo, repoPath } = cfg;
  const stamp = Date.now();
  const slug = `verify-smoke-${stamp}`;
  // The branch the daemon's worktree opens its PR from: `middle-<unit>`, where
  // unit is `issue-<epicRef>` (see worktree.ts `unitName`/`createWorktree`). The
  // smoke finds + cleans the PR by this head branch — file-mode Epics have no
  // issue number, so the gh `closes #N` finder (ghGitHub.findEpicPr) can't match.
  const agentBranch = `middle-issue-${slug}`;
  // The local seed branch the Epic file is authored on; never pushed (the daemon
  // dispatches against the local checkout, so the Epic only needs to be on disk).
  const seedBranch = `middle-smoke-${stamp}`;
  const epicRelPath = `planning/epics/${slug}.md`;
  const log = (line: string): void => console.log(`mm verify-file-mode --live: ${line}`);
  const prUrl = (n: number): string => `https://github.com/${repo}/pull/${n}`;
  const branchUrl = `https://github.com/${repo}/tree/${agentBranch}`;

  return {
    log,
    async authorEpic() {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const abs = join(repoPath, epicRelPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, EPIC_BODY(slug));
      // Seed the Epic on a fresh local branch; the daemon's worktree branches off
      // this HEAD, so its checkout carries the Epic file. No push needed.
      await git(repoPath, ["checkout", "-b", seedBranch]);
      await git(repoPath, ["add", epicRelPath]);
      await git(repoPath, ["commit", "-m", `chore: live-smoke Epic ${slug}`]);
      return { slug, branch: seedBranch, branchUrl };
    },
    async dispatch(s) {
      // runDispatch returns 0 when the workflow completes or parks; infer which by
      // re-reading the Epic file for an open question (the file-mode park trace).
      const code = await runDispatch(repoPath, s, {});
      if (code !== 0) return "failed";
      return (await hasOpenQuestion(repoPath, s)) ? "waiting-human" : "completed";
    },
    async answerQuestion(s) {
      // The human-edit the file-watcher detects: fill the answer block on disk.
      // The daemon reads the local checkout, so no push is needed.
      await fillAnswerBlock(repoPath, s, ANSWER_TEXT);
    },
    async awaitResume(s) {
      // The daemon's file-watcher polls on its cron; poll the PR until the
      // sub-issue checkbox flips (or a generous deadline passes).
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        const pr = await this.findEpicPr(s);
        if (pr && (await this.isSubIssueChecked(s, pr, 1))) return;
        await Bun.sleep(10_000);
      }
      log(`timed out after 15m waiting for the resume to flip the sub-issue checkbox`);
    },
    async findEpicPr() {
      // Match by the agent's head branch (file-mode Epics have no issue number).
      const res = await gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        agentBranch,
        "--state",
        "open",
        "--json",
        "number,isDraft",
        "--jq",
        ".[0] // empty",
      ]);
      if (!res.ok || res.stdout.trim() === "") return null;
      const pr = JSON.parse(res.stdout.trim()) as { number: number; isDraft: boolean };
      return { number: pr.number, isDraft: pr.isDraft, url: prUrl(pr.number) };
    },
    async isSubIssueChecked(_s, _pr, id) {
      // Read the Epic file at the agent branch head and parse the sub-issue's box.
      const fileRes = await gh([
        "api",
        `repos/${repo}/contents/${epicRelPath}?ref=${agentBranch}`,
        "--jq",
        ".content",
      ]);
      if (!fileRes.ok) return false;
      const text = Buffer.from(fileRes.stdout.trim(), "base64").toString("utf8");
      const { parseEpicFile } =
        await import("@middle/dispatcher/src/epic-store/epic-file/parser.ts");
      const epic = parseEpicFile(text);
      return epic.subIssues.find((sub) => sub.id === id)?.checked === true;
    },
    async cleanup(_s, _b, pr) {
      // Close the agent PR and delete its remote branch; drop the local seed branch.
      if (pr) await gh(["pr", "close", String(pr.number), "--repo", repo, "--delete-branch"]);
      await git(repoPath, ["checkout", "-"]).catch(() => {});
      await git(repoPath, ["branch", "-D", seedBranch]).catch(() => {});
    },
  };
}

/** Does the Epic file carry an open question? (the file-mode park trace). */
async function hasOpenQuestion(repoPath: string, slug: string): Promise<boolean> {
  const { readEpicFile } = await import("@middle/dispatcher/src/epic-store/epic-file-io.ts");
  const { join } = await import("node:path");
  const epic = readEpicFile(join(repoPath, "planning", "epics"), slug);
  return (epic?.conversation ?? []).some((e) => e.kind === "question" && e.status === "open");
}

/** Fill the open question's answer block on disk (the human-edit the watcher detects). */
async function fillAnswerBlock(repoPath: string, slug: string, answer: string): Promise<void> {
  const { readEpicFile, writeEpicFile } =
    await import("@middle/dispatcher/src/epic-store/epic-file-io.ts");
  const { join } = await import("node:path");
  const epicsDir = join(repoPath, "planning", "epics");
  const epic = readEpicFile(epicsDir, slug);
  if (!epic) throw new Error(`no Epic file for ${slug} to answer`);
  writeEpicFile(epicsDir, slug, {
    ...epic,
    conversation: epic.conversation.map((e) =>
      e.kind === "question" && e.status === "open" ? { ...e, answer: { body: answer } } : e,
    ),
  });
}
