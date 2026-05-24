/**
 * Verification wiring (Phase 6, build-spec item #33).
 *
 * Composes the three Phase 6 pieces into the seam the Phase 4 checkbox-revert
 * reconciler already exposes — `runGates(subIssue) => GateRunResult`:
 *
 *   1. resolve the phase's gates from `verify.toml` (`gatesForPhase`),
 *   2. run them in the worktree (`runGates` / the gate runner),
 *   3. post the per-phase evidence comment (`upsertEvidenceComment`),
 *   4. adapt the rich report down to the reconciler's pass/fail result.
 *
 * The reconciler then keeps a passing checkbox checked or reverts a failing one
 * and comments naming the failed gate. Evidence is posted on every run (pass or
 * fail); the revert comment is the reconciler's terse failure notice on top.
 */
import type { GateRunResult } from "./checkbox-revert.ts";
import { type EvidenceGateway, upsertEvidenceComment } from "./gate-evidence.ts";
import { type GateRunReport, runGates as runGateList } from "./gate-runner.ts";
import { gatesForPhase, type VerifyConfig } from "./verify-config.ts";

export type PhaseGatesDeps = {
  repo: string;
  /** The Epic PR the evidence comment lands on. */
  prNumber: number;
  /** The workstream worktree the gates execute in. */
  worktreePath: string;
  /** The repo's loaded gate declaration. */
  config: VerifyConfig;
  /** GitHub access for posting/updating the evidence comment. */
  github: EvidenceGateway;
};

/**
 * Build the `runGates` function the checkbox-revert reconciler consumes: it runs
 * sub-issue N's gates in the worktree, posts evidence, and returns the
 * pass/fail outcome the reconciler reverts on.
 */
export function makeRunPhaseGates(
  deps: PhaseGatesDeps,
): (subIssue: number) => Promise<GateRunResult> {
  // The reconciler awaits this per `[ ] → [x]` transition; a throw it lets
  // escape aborts reconcileCheckboxes mid-loop — skipping later phases' reverts
  // and the state persist. So every failure here is funneled into a loud
  // non-ok verdict the reconciler can revert + comment on, never a throw.
  return async (subIssue) => {
    const gates = gatesForPhase(deps.config, subIssue);

    let report: GateRunReport;
    try {
      report = await runGateList(gates, { cwd: deps.worktreePath });
    } catch {
      // The runner itself couldn't execute (e.g. the worktree path is gone or a
      // process couldn't be spawned). Treat it as a failed phase so the box
      // reverts and the agent re-ticks to retry, rather than aborting the loop.
      return { ok: false, failedGate: "gate-runner" };
    }

    try {
      await upsertEvidenceComment({
        gh: deps.github,
        repo: deps.repo,
        prNumber: deps.prNumber,
        subIssue,
        report,
      });
    } catch {
      // Posting evidence is a GitHub side effect, not the gate verdict. A failure
      // here must not abort reconciliation; surface non-ok so the box reverts
      // (the agent re-ticks → retries gates + evidence) rather than leaving a
      // checked box with no evidence. A real gate failure still names its gate.
      return { ok: false, failedGate: report.failedGate ?? "evidence-comment" };
    }

    return report.ok ? { ok: true } : { ok: false, failedGate: report.failedGate ?? "unknown" };
  };
}
