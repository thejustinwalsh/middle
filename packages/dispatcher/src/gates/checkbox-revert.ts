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

const HEADING_RE = /^#{1,6}\s/;
const STATUS_HEADING_RE = /^#{1,6}\s+status\b/i;

/**
 * The `[start, end)` line range of the **first** `## Status` section — from the
 * line after that heading up to (not including) the next heading, or end of body.
 * Returns null when there's no Status section. Pinning to the *first* section is
 * the contract both the parser and the reverter share: a later `## Status` block,
 * or a `#N` checkbox under any other heading, is out of scope and never touched.
 */
function firstStatusSectionRange(lines: string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const isHeading = HEADING_RE.test(lines[i]!);
    if (start === -1) {
      if (isHeading && STATUS_HEADING_RE.test(lines[i]!)) start = i + 1;
    } else if (isHeading) {
      return { start, end: i };
    }
  }
  return start === -1 ? null : { start, end: lines.length };
}

/**
 * Parse the first `## Status` section's checkbox list. Each entry is a list item
 * carrying a `#N` issue reference; the `#N` is the sub-issue the checkbox tracks.
 */
export function parseStatusCheckboxes(body: string): StatusCheckbox[] {
  const lines = body.split("\n");
  const range = firstStatusSectionRange(lines);
  if (!range) return [];
  const result: StatusCheckbox[] = [];
  for (let i = range.start; i < range.end; i++) {
    const box = /^\s*[-*]\s+\[([ xX])\]\s+.*?#(\d+)/.exec(lines[i]!);
    if (box) result.push({ subIssue: Number(box[2]), checked: box[1] !== " " });
  }
  return result;
}

/**
 * Flip the `[x]` back to `[ ]` on the first-`## Status`-section line that
 * references `#subIssue`. Scoped to that section (via `firstStatusSectionRange`)
 * so a checked `#N` checkbox elsewhere — a Related/Tasks list, a later Status
 * block, a quoted template — is never mutated.
 */
function revertCheckbox(body: string, subIssue: number): string {
  const lines = body.split("\n");
  const range = firstStatusSectionRange(lines);
  if (!range) return body;
  for (let i = range.start; i < range.end; i++) {
    const box = /^\s*[-*]\s+\[[xX]\]\s+.*?#(\d+)/.exec(lines[i]!);
    if (box && Number(box[1]) === subIssue) {
      lines[i] = lines[i]!.replace(/\[[xX]\]/, "[ ]");
    }
  }
  return lines.join("\n");
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
