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

/**
 * Entry point for `mm verify-file-mode`. Runs the in-tmpdir integration fixture
 * and prints the structured report. Returns a process exit code (0 green / 1
 * failed). The `--live` real-GitHub path is added by the sibling sub-issue.
 */
export async function runVerifyFileMode(): Promise<number> {
  const result = await runFileModeSmoke();
  return printSmokeReport(result);
}
