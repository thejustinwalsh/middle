/**
 * Anti-staleness reconciliation (Epic #143, sub-issue #146) — the document-level
 * twin of `reconcileMergedParks`. After merges it (1) **closes issues whose work
 * has landed** (a merged PR records it as closing them, yet they're still open)
 * with an evidence comment, and (2) **flags spec drift** — spec lines that
 * describe a *future* phase whose work has already merged — by filing a
 * proposal-first "reconcile the spec" task. It never edits the spec prose and
 * never closes an issue without an evidence trail.
 */
import type { GitHubGateway, MergedPrRef } from "./github.ts";

/** Default cap on issues closed / tasks filed per pass, so one sweep can't storm. */
const DEFAULT_MAX_PER_PASS = 25;

/** A spec line that describes a future phase whose work has already merged. */
export type SpecDrift = {
  lineNumber: number;
  line: string;
  phase: number;
};

/**
 * Matches future-tense spec phrasing tied to a phase number — "lands in Phase 9",
 * "ships in phase 12", "planned for Phase 3". The captured group is the phase.
 * Two shapes: "<future-verb> in phase N", and the verb-less "planned for phase N".
 */
const DRIFT_RE =
  /\b(?:(?:lands?|ships?|arrives?|will\s+(?:land|ship|arrive)|to\s+be\s+(?:done|built|added))\s+in|planned\s+for)\s+phase\s+(\d+)\b/i;

/**
 * Find spec lines that describe a future phase whose work has already merged.
 * Pure: scans `specText` line by line and flags matches whose phase number is in
 * `mergedPhases`. This is the concrete drift class the spec calls out — a stale
 * "lands in Phase N" line surviving past that phase's merge.
 */
export function detectSpecDrift(specText: string, mergedPhases: ReadonlySet<number>): SpecDrift[] {
  const drifts: SpecDrift[] = [];
  const lines = specText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = DRIFT_RE.exec(lines[i]!);
    if (!m) continue;
    const phase = Number(m[1]);
    if (mergedPhases.has(phase)) {
      drifts.push({ lineNumber: i + 1, line: lines[i]!.trim(), phase });
    }
  }
  return drifts;
}

/** The deterministic title of a reconcile task for a drifted phase (dedupe key). */
export function reconcileTaskTitle(phase: number): string {
  return `chore(spec): reconcile stale "Phase ${phase}" reference`;
}

/** Extract the phase number from a `phase:N` label, or null. */
function phaseOfLabel(label: string): number | null {
  const m = /^phase:(\d+)$/i.exec(label.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Input contract for one {@link reconcileStaleness} pass over a single repo: the
 * GitHub gateway it reads/mutates, plus how to read the build-spec for drift
 * detection.
 */
export type StalenessDeps = {
  /** The `owner/name` repo slug to reconcile. */
  repo: string;
  github: Pick<
    GitHubGateway,
    "listOpenIssues" | "listMergedPrsClosingRefs" | "closeIssue" | "createIssue"
  >;
  /** Read the build-spec text, or null if the repo has no spec to check. */
  readSpec: () => string | null;
  /** The spec's repo-relative path, named in the reconcile task body. */
  specPath: string;
  /**
   * Cap on the *total* mutations (closes + filed tasks) per pass — a single
   * shared budget, so one sweep can't storm (default {@link DEFAULT_MAX_PER_PASS}).
   */
  maxPerPass?: number;
};

/** Output of one {@link reconcileStaleness} pass — what it changed and detected. */
export type StalenessResult = {
  /** Issue numbers closed as landed-but-open this pass. */
  closed: number[];
  /** Spec drifts detected this pass. */
  drift: SpecDrift[];
  /** Issue numbers of reconcile tasks filed this pass. */
  filed: number[];
};

/**
 * Run one reconciliation pass over `repo`. Closes landed-but-open issues (with an
 * evidence comment naming the merged PR), then — using the phase labels of those
 * just-landed issues — detects spec lines that still call a now-merged phase
 * "future" and files a proposal-first reconcile task per drift (deduped by title
 * against open issues). Per-item failures are isolated so one bad write doesn't
 * abort the pass.
 */
export async function reconcileStaleness(deps: StalenessDeps): Promise<StalenessResult> {
  // One shared budget across *all* mutations this pass — closes AND filed tasks
  // draw from it, so the documented "per pass" cap bounds the total write storm,
  // not each bucket independently (which would let a pass do `cap` of each).
  let budget = deps.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const open = await deps.github.listOpenIssues(deps.repo);
  const openByNumber = new Map(open.map((i) => [i.number, i]));

  const merged = await deps.github.listMergedPrsClosingRefs(deps.repo);
  const closed: number[] = [];
  const mergedPhases = new Set<number>();

  for (const ref of merged) {
    for (const issueNum of closingTargets(ref)) {
      if (budget <= 0) break;
      const issue = openByNumber.get(issueNum);
      if (!issue) continue; // already closed, or never open → nothing to reconcile
      try {
        await deps.github.closeIssue(
          deps.repo,
          issueNum,
          `Work landed in merged PR #${ref.number} — closed by middle's anti-staleness reconciliation. Reopen if this was premature.`,
        );
        closed.push(issueNum);
        budget -= 1;
        openByNumber.delete(issueNum); // a PR closing it twice shouldn't double-close
        for (const label of issue.labels) {
          const phase = phaseOfLabel(label);
          if (phase !== null) mergedPhases.add(phase);
        }
        console.error(
          `[staleness] ${deps.repo}#${issueNum} landed in merged PR #${ref.number} → closed`,
        );
      } catch (error) {
        console.error(
          `[staleness] failed to close ${deps.repo}#${issueNum} (continuing): ${(error as Error).message}`,
        );
      }
    }
  }

  // Spec drift: a line still calling a now-merged phase "future". Proposal-first —
  // file a reconcile task, never touch the prose. Dedupe against open issues (and
  // tasks filed earlier this pass) by the deterministic title.
  const specText = deps.readSpec();
  const drift = specText ? detectSpecDrift(specText, mergedPhases) : [];
  const filed: number[] = [];
  const existingTitles = new Set(open.map((i) => i.title));
  const seenPhases = new Set<number>();
  for (const d of drift) {
    if (budget <= 0) break;
    if (seenPhases.has(d.phase)) continue;
    seenPhases.add(d.phase);
    const title = reconcileTaskTitle(d.phase);
    if (existingTitles.has(title)) continue; // a task is already open
    try {
      const number = await deps.github.createIssue(deps.repo, {
        title,
        body: reconcileTaskBody(d, deps.specPath),
        labels: ["housekeeping"],
      });
      filed.push(number);
      budget -= 1;
      console.error(
        `[staleness] ${deps.repo}: filed reconcile task #${number} for Phase ${d.phase}`,
      );
    } catch (error) {
      console.error(
        `[staleness] failed to file reconcile task for Phase ${d.phase} (continuing): ${(error as Error).message}`,
      );
    }
  }

  return { closed, drift, filed };
}

/** Dedupe a merged PR's closing refs (a PR can list the same issue twice). */
function closingTargets(ref: MergedPrRef): number[] {
  return [...new Set(ref.closes)];
}

/** The proposal-first reconcile-task body — describes the drift, proposes the edit. */
function reconcileTaskBody(drift: SpecDrift, specPath: string): string {
  return [
    "## Context",
    `Anti-staleness reconciliation (Epic #143) found a spec line that describes **Phase ${drift.phase}** as future work, but that phase's work has already merged.`,
    "",
    `\`${specPath}:${drift.lineNumber}\`:`,
    "",
    "> " + drift.line,
    "",
    "## Acceptance criteria",
    `- [ ] The spec line is updated to reflect that Phase ${drift.phase}'s work has landed (or the line is removed).`,
    "",
    "## Out of scope",
    "- Any code change. This is a documentation reconcile only — the edit is a normal dispatched workstream.",
    "",
    "## References",
    `- Spec: \`${specPath}\``,
    "- Parent: #143",
  ].join("\n");
}
