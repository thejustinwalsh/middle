# Decisions — Epic #190 (file-backed Epic store)

Running log of decisions worth more than two lines. Distilled into PR review comments
at finalize time.

## Gateway param naming: `ref: string` (generic) vs `epicRef: string` (seam)
**File(s):** `packages/dispatcher/src/github.ts`, `poller.ts`, `state-issue.ts`
**Date:** 2026-06-03

**Decision:** Gateway methods take a generic `ref: string` for their issue/PR identifier;
the workflow seam (`ImplementationInput`, `WorkflowRecord`, build-deps callbacks, gate
inputs) uses `epicRef: string` where the value genuinely is the Epic.
**Why:** Sub-issue #191's text literally says "`epicRef: string`", but `listIssueComments`,
`postComment`, `getIssueLabels`, `addLabel`, `closeIssue` are called with PR numbers and
sub-issue numbers too — not just the Epic — so naming the param `epicRef` would be wrong at
those callsites (a reviewer would flag it). The authoritative spec
(`docs/superpowers/specs/2026-05-29-file-backed-epic-store-design.md`, "The three new file
gateways") uses the generic name `ref` in every gateway-method table. Spec is source of
truth on the interface shape; the seam name `epicRef` is correct where the value is the Epic.
**Evidence:** spec gateway tables (`listIssueComments(repo, ref)`, `postComment(repo, ref, body)`,
`findEpicPr(repo, ref)`); callsites `gate-evidence.ts` (PR number), `pr-divergence.ts` (sub-issue),
`plan-comment.ts` (epic) all share `listIssueComments`.

## ghGitHub parses `ref`/`epicRef` to a number at the gh boundary
**File(s):** `packages/dispatcher/src/github.ts`, `poller-gateway.ts`
**Date:** 2026-06-03

**Decision:** A single `refToIssueNumber(ref)` helper converts the string ref to an integer
at each `gh`-calling method; it throws a clear error when the ref is not a parseable positive
integer (github mode contract: numeric-string refs only).
**Why:** github mode keeps working unchanged — the workflow layer now speaks strings, and the
only place that needs an int is the `gh` CLI call itself. Centralizing the parse keeps the
error message uniform and the "numeric-string only" contract in one place.
**Evidence:** sub-issue #191 acceptance criterion 2.

## Scope boundary: which read-types became `epicRef`, which stayed numeric
**File(s):** `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-06-03

**Decision:** Only the **resume/reconcile-seam** read types became string-keyed —
`PollableWait`, `ParkedWorkflow`, `RunningWorkflow` now expose `epicRef: string`
(SELECT `epic_ref`, filter `epic_ref IS NOT NULL`), because their values flow into
the now-string gateway methods. The **display** read types stayed numeric:
`ActiveImplementationWorkflow` (feeds the state-issue `InFlightItem.issue: number`)
and `NonTerminalWorkflow` + the `/control/events` SSE `epic` field (the dashboard's
numeric column). `getWorkflow` returns BOTH `epicNumber` (derived) and `epicRef`.
**Why:** `InFlightItem.issue: number` is part of the authoritative state-issue schema
(`schema.v1.ts`) with a byte-identical round-trip invariant — changing it is a schema
bump, explicitly NOT in #191's "files likely to change", and a file-mode concern for a
later phase. The criterion "every SELECT reads/writes epic_ref" is scoped to the SELECTs
that feed the epicRef seam; display SELECTs feeding numeric schemas are out of scope.
**Evidence:** `packages/state-issue/CLAUDE.md` (round-trip invariant); Epic #190 plan's
#191 file list omits `schema.v1.ts`/`packages/state-issue`.

## `createWorkflowRecord` writes both columns; dashboard tests updated
**File(s):** `packages/dispatcher/src/workflow-record.ts`, `packages/dashboard/test/{helpers,api,sse}.*`
**Date:** 2026-06-03

**Decision:** github-mode `createWorkflowRecord` now writes BOTH `epic_number` (parsed
from the numeric ref) and `epic_ref` (the stringified number). Two #187 dashboard tests
that asserted a github row's `epicRef` is `null` were updated to expect the stringified
number; the `EpicRef` component is unaffected (it keys its `#N` render off `epic`, only
consulting `epicRef` when `epic === null`).
**Why:** The spec's dual-column contract is "github mode writes both columns"; the #187
tests were written against the foundation's incomplete `createWorkflowRecord` (which
wrote only `epic_number`). Completing the write path makes those `epicRef: null`
assertions stale — the faithful fix is to assert the new value, not to fake the old DB
state in the test helper. github-mode *rendering* is byte-for-byte unchanged.
**Evidence:** spec "Config schema" (dual-column); `EpicRef.tsx` (epicNumber-first render).

## Worktree seam is string-keyed (`epicRef`), unit path unchanged
**File(s):** `packages/dispatcher/src/worktree.ts`
**Date:** 2026-06-03

**Decision:** `CreateWorktreeOpts.issueNumber?: number` became `epicRef?: string`; the
dispatch-unit directory stays `issue-${epicRef}` (so `issue-27` is byte-identical for a
github ref). The pr-divergence reconciler parses the numeric epic from the head ref and
stringifies it at the `createWorktree` boundary.
**Why:** The workflow seam now threads a string; the worktree directory must accept it so
a file-mode slug yields `issue-<slug>` without a numeric coercion. github paths are unchanged.
**Evidence:** sub-issue #191 (string seam everywhere); worktree layout in root `CLAUDE.md`/spec.
