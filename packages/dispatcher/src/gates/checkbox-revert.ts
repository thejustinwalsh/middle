/**
 * Checkbox-revert reconciler (skill enforcement gate #3).
 *
 * After every push by the agent, the dispatcher inspects the Epic PR's "Status"
 * checkbox list — one checkbox per sub-issue, each carrying its `#N` reference.
 * A checkbox that transitioned `[ ] → [x]` for sub-issue N runs sub-issue N's
 * verification gates; if any gate fails the dispatcher reverts the checkbox and
 * posts a comment naming the failed gate. The agent's next turn sees the revert
 * and the failure context and stays on that sub-issue.
 *
 * The gate *runner* itself is injected — full gate execution (lint, typecheck,
 * test, project acceptance script) integrates in Phase 6. This module owns the
 * checkbox detection, transition diffing, revert, and comment.
 */

export type StatusCheckbox = { subIssue: number; checked: boolean };

/**
 * Parse the Status section's checkbox list. Each entry is a list item under the
 * first "## Status" heading carrying a `#N` issue reference; the `#N` is the
 * sub-issue the checkbox tracks. Collection stops at the next heading.
 */
export function parseStatusCheckboxes(body: string): StatusCheckbox[] {
  const lines = body.split("\n");
  const result: StatusCheckbox[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s+status\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const box = /^\s*[-*]\s+\[([ xX])\]\s+.*?#(\d+)/.exec(line);
    if (box) result.push({ subIssue: Number(box[2]), checked: box[1] !== " " });
  }
  return result;
}

/**
 * Flip the `[x]` back to `[ ]` on the Status line that references `#subIssue`.
 * Scoped to the first `## Status` section (mirroring `parseStatusCheckboxes`) so
 * a checked `#N` checkbox elsewhere in the body — a Related/Tasks list, a quoted
 * template — is never mutated.
 */
function revertCheckbox(body: string, subIssue: number): string {
  const lines = body.split("\n");
  let inSection = false;
  return lines
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) {
        inSection = /^#{1,6}\s+status\b/i.test(line);
        return line;
      }
      if (!inSection) return line;
      const box = /^(\s*[-*]\s+)\[[xX]\](\s+.*?#\d+)/.exec(line);
      if (box && new RegExp(`#${subIssue}\\b`).test(line)) {
        return line.replace(/\[[xX]\]/, "[ ]");
      }
      return line;
    })
    .join("\n");
}

export type GateRunResult = { ok: true } | { ok: false; failedGate: string };

export type CheckboxReconcileDeps = {
  /** Current Epic PR body. */
  getPrBody: () => Promise<string>;
  /** Overwrite the Epic PR body (used to revert a checkbox). */
  setPrBody: (body: string) => Promise<void>;
  /** Post a comment on the Epic PR explaining a revert. */
  postComment: (body: string) => Promise<void>;
  /** Run sub-issue N's verification gates. */
  runGates: (subIssue: number) => Promise<GateRunResult>;
  /** The checked-state map recorded after the previous reconcile pass. */
  getPreviousState: () => Promise<Record<number, boolean>>;
  /** Persist the checked-state map for the next pass to diff against. */
  setPreviousState: (state: Record<number, boolean>) => Promise<void>;
};

/**
 * Reconcile the Status checkboxes against the previous pass: run gates for each
 * `[ ] → [x]` transition, revert + comment on failures, and persist the new
 * (post-revert) state so a reverted box isn't re-treated as a transition.
 */
export async function reconcileCheckboxes(
  deps: CheckboxReconcileDeps,
): Promise<{ reverted: number[] }> {
  let body = await deps.getPrBody();
  const previous = await deps.getPreviousState();
  const current = parseStatusCheckboxes(body);

  const reverted: number[] = [];
  for (const box of current) {
    const wasChecked = previous[box.subIssue] === true;
    if (!box.checked || wasChecked) continue; // only fresh [ ] → [x] transitions

    const gate = await deps.runGates(box.subIssue);
    if (!gate.ok) {
      body = revertCheckbox(body, box.subIssue);
      await deps.postComment(
        `Checkbox for #${box.subIssue} reverted: the **${gate.failedGate}** verification gate ` +
          `failed. Address it and re-tick the box once the gate passes.`,
      );
      reverted.push(box.subIssue);
    }
  }

  if (reverted.length > 0) await deps.setPrBody(body);

  // Record the post-revert state: a reverted box is now unchecked, so it won't
  // be re-treated as a transition on the next push.
  const nextState: Record<number, boolean> = {};
  for (const box of parseStatusCheckboxes(body)) nextState[box.subIssue] = box.checked;
  await deps.setPreviousState(nextState);

  return { reverted };
}
