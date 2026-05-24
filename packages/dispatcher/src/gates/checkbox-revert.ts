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
// The contract is the first level-2 `## Status` heading, exact text. Two hashes
// (not `#{1,6}`) so `# Status` / `### Status` can't capture the range; exact
// text with an end-anchor so lookalikes like `## Status notes` can't either.
const STATUS_HEADING_RE = /^##\s+status\s*$/i;

/**
 * Mark each line inside a fenced code block (``` or ~~~), and the fence
 * delimiters themselves, so a `## Status` heading or a `- [x] #N` line that
 * appears in a *quoted example* (a PR template, a decisions excerpt) is never
 * mistaken for the real Status section.
 */
function fencedLineMask(lines: string[]): boolean[] {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return true; // the delimiter line itself is not content
    }
    return inFence;
  });
}

/**
 * The `[start, end)` line range of the **first** real `## Status` section — from
 * the line after that heading up to (not including) the next heading, or end of
 * body; null when there's none. Pinned to the first level-2 `## Status` heading,
 * fenced examples excluded. Both the parser and the reverter share this so they
 * can never disagree on which lines are in scope.
 */
function firstStatusSectionRange(
  lines: string[],
  fenced: boolean[],
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
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
  const fenced = fencedLineMask(lines);
  const range = firstStatusSectionRange(lines, fenced);
  if (!range) return [];
  const result: StatusCheckbox[] = [];
  for (let i = range.start; i < range.end; i++) {
    if (fenced[i]) continue;
    const box = /^\s*[-*]\s+\[([ xX])\]\s+.*?#(\d+)/.exec(lines[i]!);
    if (box) result.push({ subIssue: Number(box[2]), checked: box[1] !== " " });
  }
  return result;
}

/**
 * Flip the `[x]` back to `[ ]` on the first-`## Status`-section line that
 * references `#subIssue`. Scoped to that section (via `firstStatusSectionRange`,
 * fenced examples excluded) so a checked `#N` checkbox anywhere else — a
 * Related/Tasks list, a later Status block, a quoted template — is never mutated.
 */
function revertCheckbox(body: string, subIssue: number): string {
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);
  const range = firstStatusSectionRange(lines, fenced);
  if (!range) return body;
  for (let i = range.start; i < range.end; i++) {
    if (fenced[i]) continue;
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
