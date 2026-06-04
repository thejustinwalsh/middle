/**
 * `mm verify-file-mode` — the operator's file-mode verification command. Runs the
 * deterministic file-mode smoke (the same `runFileModeSmoke` drive CI runs on
 * every commit) over a throwaway tmpdir repo and prints a `mm doctor`-style
 * structured report: one `PASS`/`FAIL` line per phase (init → author → dispatch →
 * park → answer → resume → complete) with its wall-time, then a summary. Exits 0
 * when every section passes, 1 otherwise — with the failing section named on the
 * last printed line so a CI log's tail tells you where it broke.
 *
 * The default path needs no daemon, no gh, and no network. `--live --repo <repo>`
 * (added by the sibling sub-issue) swaps the stubbed gh boundary for real GitHub.
 */

import {
  runFileModeSmoke,
  type SmokeResult,
} from "@middle/dispatcher/src/epic-store/file-mode-smoke.ts";

const HEADER = "middle — file-mode verification";

/** Render one smoke result as the structured report and return the exit code. */
export function printSmokeReport(
  result: SmokeResult,
  sink: (line: string) => void = console.log,
): number {
  sink(`${HEADER}\n`);
  let total = 0;
  for (const s of result.sections) {
    total += s.ms;
    const status = s.ok ? "PASS" : "FAIL";
    sink(`  ${status}  ${s.name.padEnd(9)} ${`${s.ms}ms`.padStart(8)}  ${s.detail}`);
  }
  sink("");
  const passed = result.sections.filter((s) => s.ok).length;
  sink(`${passed}/${result.sections.length} sections passed in ${total}ms`);
  // The LAST line is the verdict: on failure it names the failing section so a
  // truncated CI log still tells you where it broke.
  if (result.ok) {
    sink("all sections pass.");
    return 0;
  }
  const failed = result.sections.find((s) => !s.ok);
  sink(`FAIL: ${result.failedSection} — ${failed?.detail ?? "unknown"}`);
  return 1;
}

/** Options for {@link runVerifyFileMode}. */
export type VerifyFileModeOptions = {
  /** Run the real-GitHub smoke instead of the in-tmpdir integration fixture. */
  live?: boolean;
  /** `owner/name` of the designated test repo (required with `--live`). */
  repo?: string;
  /** Local checkout of the test repo for `--live` (defaults to cwd). */
  repoPath?: string;
};

/**
 * Entry point for `mm verify-file-mode`. The default path runs the in-tmpdir
 * integration fixture and prints the structured report; `--live` delegates to the
 * real-GitHub smoke. Returns a process exit code (0 green / 1 failed).
 */
export async function runVerifyFileMode(opts: VerifyFileModeOptions = {}): Promise<number> {
  if (opts.live) {
    const { runVerifyFileModeLive } = await import("./verify-file-mode-live.ts");
    return runVerifyFileModeLive({ repo: opts.repo, repoPath: opts.repoPath });
  }
  const result = await runFileModeSmoke();
  return printSmokeReport(result);
}
