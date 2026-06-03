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

## `EpicListItem` gains `ref`; `number` nullable; numeric epics cache skips file Epics
**File(s):** `packages/dispatcher/src/github.ts`, `epics-cache.ts`
**Date:** 2026-06-03

**Decision:** `EpicListItem` gains a required `ref: string` (github: `String(number)`,
file: slug) and `number` becomes `number | null` (null for a file Epic). `refreshEpics`
skips rows with `number === null` — the browse cache table is numeric-keyed `(repo, number)`.
**Why:** `fileEpicGateway.listOpenEpics` must return file Epics, which have only a slug.
The browse cache is github-only this phase (`refreshEpics` is always called with `ghGitHub`
in `main.ts`); a file-aware browse cache is a later phase, so skipping null-numbered rows
keeps the numeric table honest without a schema change. github rows are unaffected.
**Evidence:** `epics-cache.ts` `(repo, number)` PK; #192 integration scope (dispatch+postComment, not browse).

## File-mode PR-poll resolution (`findPrForEpic`) is a Phase-2 refinement
**File(s):** `packages/dispatcher/src/epic-store/file-poll-gateway.ts`
**Date:** 2026-06-03

**Decision:** `filePollGateway.listIssueComments` is fully file-backed (conversation →
poll comments with `authorIsBot` from the marker — the #178-class closure). `getRateLimit`
delegates to gh. `findPrForEpic`/`findEpicPrLifecycle` delegate to gh for a numeric ref but
return `null` for a file-mode slug (no PR yet / Phase-1 limitation) rather than feed a slug
into gh's `Closes #<number>` search (which `refToIssueNumber` would reject).
**Why:** github's PR-finders resolve a PR by `Closes #<epicNumber>`, which a file Epic (slug,
no GitHub issue) can't carry; the file↔PR link is the `<!-- middle:epic <slug> -->` body
marker + `meta.pr`, and `PollGateway` has no by-PR-number snapshot method to fetch through.
Spec Phase 1 is "File-Epic dispatch (no watcher)"; review-resume on file mode rides Phase 2's
watcher work. Returning null is non-throwing and honest; question-resume (the Phase-1 path)
is unaffected.
**Evidence:** spec "Phase plan" (Phase 1 vs 2); spec poll-gateway table ("delegate to gh");
`poller-gateway.ts` `Closes #${epicNumber}` search.

## Per-repo selection is a routing gateway, not a per-repo deps build
**File(s):** `packages/dispatcher/src/epic-store/index.ts`, `build-deps.ts`
**Date:** 2026-06-03

**Decision:** The daemon builds ONE `ImplementationDeps` and registers ONE workflow
(unchanged). Per-repo mode is implemented as a **routing `EpicGateway`**
(`makeRoutingEpicGateway`) that reads `repo_config` per call and delegates to the
repo's file or gh backend, keyed on the method's `repo` arg. `build-deps` defaults
`github`/`planCommentReader` to the router and routes `postQuestion` by mode
(file → `appendQuestion`, github → `formatPauseComment` via gh).
**Why:** The spec's "buildImplementationDeps picks the trio" reads as a single
selection, but the daemon serves many repos through one registration — so the
selection must happen per-call. Every gateway method already takes `repo` first, so
a router is the minimal, interface-preserving way to run github repo A and file repo
B under one daemon. An injected `args.github`/`args.postQuestion` still overrides
(tests). github-mode repos route to `ghGitHub`, so behavior is byte-identical.
**Evidence:** spec "Architecture" ("daemon runs both modes simultaneously"); `main.ts`
registers one workflow with one deps.

## `/control/dispatch` accepts a string `epicRef` (file slug) or numeric `epicNumber`
**File(s):** `packages/dispatcher/src/hook-server.ts`
**Date:** 2026-06-03

**Decision:** The control endpoint now accepts either a non-empty string `epicRef`
(file mode) or an integer `epicNumber` ≥ 1 (github mode, stringified), building the
string-keyed `ControlDispatchInput.epicRef` from whichever is present.
**Why:** A file-mode dispatch references a slug, which the prior numeric-only
validation rejected. This makes the dispatch entry mode-agnostic so #193's selector
is reachable end-to-end; the CLI sends the right field in #194. Existing numeric
clients are unaffected (the github branch is unchanged).
**Evidence:** #193 integration criterion (HTTP dispatch with a file-mode slug).

## `mm resume` is overloaded: clear-pause vs answer-a-parked-Epic
**File(s):** `packages/cli/src/index.ts`, `commands/resume-answer.ts`
**Date:** 2026-06-03

**Decision:** `mm resume <repo>` keeps its existing meaning (clear the repo's
auto-dispatch pause). `mm resume <repo> <epic> --answer "<text>"` is the NEW
answer-resume: it POSTs `/control/resume`, which fires the parked Epic's resume
signal. The router branches on whether `<epic>`/`--answer` are present (both
required together).
**Why:** sub-issue #194 specifies `mm resume <epic> --answer`, but `mm resume`
already exists (pause-clear) and middle commands always take a `<repo>`. Overloading
one command with an optional `<epic> --answer` preserves back-compat while adding the
Phase-1 manual-unblock escape hatch. The daemon's `control.resume` mirrors the
poller's fire (`engine.signal(workflowId, RESUME_EVENT, …)` + `markSignalFired`) and
looks up the parked workflow by `epic_ref`, so it works in both modes.
**Evidence:** existing `runResume` (pause-clear) in `commands/pause.ts`; poller's
`fireSignal` wiring in `main.ts`.

## `mm dispatch` accepts a slug or number; numeric refs keep the gh label fetch
**File(s):** `packages/cli/src/commands/dispatch.ts`, `index.ts`
**Date:** 2026-06-03

**Decision:** `mm dispatch <repo> <epic>` (and `--epic <ref>`) accept a file slug or
a github issue number. A digit-leading ref must be a whole number ≥ 1 (else rejected);
a non-digit-leading ref is a slug. Only a numeric ref triggers the `agent:<name>`
label lookup via gh; a slug skips gh (file-mode Epics carry their adapter in the file
meta, which the daemon reads). The POST body now sends `epicRef` (string).
**Why:** file-mode Epics are slugs; the dispatch entry must accept them and avoid a gh
call for a non-GitHub Epic. github-mode numeric dispatch is unchanged in behavior.
**Evidence:** sub-issue #194 (slug-or-number positional + `--epic`).
