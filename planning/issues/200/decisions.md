# Issue #200 — decisions log

## Resolve a file-mode Epic's PR via `meta.pr`, not a PR-body marker
**File(s):** `packages/dispatcher/src/epic-store/file-poll-gateway.ts`, `packages/dispatcher/src/poller-gateway.ts:79`
**Date:** 2026-06-03

**Decision:** For a file-mode slug, `findPrForEpic`/`findEpicPrLifecycle` resolve the Epic's PR number from the Epic file's durable `meta.pr` stamp, then fetch the snapshot/lifecycle by number via two new by-PR-number gateway methods (`prSnapshot`/`prLifecycle`).
**Why:** The issue offered "resolve by marker / `meta.pr`". The `<!-- middle:epic <slug> -->` PR-body marker is **not actually written** anywhere in the current codebase (grep finds no writer), whereas `meta.pr` is already the established resolution key — `file-epic-gateway.findEpicPr` resolves the PR object the exact same way (`epic.meta.pr` → `gh.getPullRequest`). Mirroring that keeps one resolution mechanism for file-mode PRs instead of introducing a second (a body marker) that nothing maintains. `meta.pr` is stamped when the PR opens, so it's authoritative.
**Evidence:** `file-epic-gateway.ts` `findEpicPr` already does `epic.meta.pr === undefined → null; else gh.getPullRequest(repo, epic.meta.pr)`. The renderer/parser already round-trip `pr:` in the meta block.

## Add by-PR-number `prSnapshot`/`prLifecycle` to the shared `PollGateway` interface
**File(s):** `packages/dispatcher/src/poller.ts:84`, `packages/dispatcher/src/poller-gateway.ts`
**Date:** 2026-06-03

**Decision:** Widen `PollGateway` with `prSnapshot(repo, prNumber)` and `prLifecycle(repo, prNumber)` rather than structurally widening only the file gateway's `gh` backend dep.
**Why:** The github finder is genuinely "resolve the Epic's PR number, then fetch by number"; exposing the fetch half as its own method is the honest decomposition and lets `ghPollGateway.findPrForEpic` reuse it (DRY — one snapshot builder). The alternative (a richer `gh` backend type on just `FilePollGatewayDeps`) loses the extra methods to structural erasure at the `PollGateway` boundary in the routing chain (`buildFileGateways`/`trioForRepo` thread `ghPoll: PollGateway`), forcing fragile type-plumbing across the public routing API for file mode only. The interface widening costs two extra methods on ~4 test stubs and the routing delegate — mechanical and type-checked.
**Evidence:** `fetchPrSnapshot` is now the single snapshot builder shared by `findPrForEpic` and `prSnapshot`. `fetchPrSnapshot`/`fetchPrLifecycle` swallow a `gh pr view` failure → `null`, so a stale `meta.pr` degrades to "no PR" instead of throwing the whole poll pass.

## Bonus: the merged/closed reconcile path works in file mode for free
**File(s):** `packages/dispatcher/src/poller.ts` `reconcileMergedParks`
**Date:** 2026-06-03

**Decision:** No separate work for reconcile — it already calls `findEpicPrLifecycle`, which now resolves a slug via `meta.pr`.
**Why:** Same gateway method, same blast radius. A file-mode Epic whose PR is merged/closed now reconciles to `completed`/`cancelled` rather than stalling in `waiting-human`, identical to github mode.

## InFlightItem.issue: number → string (additive, stays schema v1)
**File(s):** `packages/state-issue/src/schema.v1.ts:38`, `parser.ts:195`, `schemas/state-issue.v1.md:46`
**Date:** 2026-06-03

**Decision:** Widen `InFlightItem.issue` from `number` to `string` (a numeric Epic number OR a file-mode slug), parse `#([\w-]+)` instead of `#(\d+)`, keep schema **v1** rather than bumping to v2.
**Why:** A file-mode Epic has no GitHub issue number; its in-flight row must carry the slug. The change is additive — numeric refs are a subset of string refs and render identically (`**#200**`), so byte-identical round-trip holds (verified by the fuzz + sample-state round-trip tests, now seeded with slug refs). A v1→v2 bump would force a parallel parser/renderer/validate/schema-doc fork for a backward-compatible widening — cost with no safety gain. Scoped to `InFlightItem` (the gap's explicit ask); the Ready table's `epic` cell is already a raw string so it accommodates slugs without a type change, and the auto-dispatch ref-extractor (`parseEpicRef`) reads `#([\w-]+)` from it. needs-human/blocked/excluded stay numeric (out of the gap's scope).

## Routing StateGateway + sentinel-0 for file mode
**File(s):** `packages/dispatcher/src/epic-store/index.ts` (`makeRoutingStateGateway`), `main.ts` (auto-dispatch + recommender wiring)
**Date:** 2026-06-03

**Decision:** Add `makeRoutingStateGateway` (mirrors the epic/poll routers) and wire both auto-dispatch's `readState` and the recommender's `stateIssue` through it. File-mode repos use a **sentinel issue number `0`** that the file state gateway ignores (it reads `state_file`); github repos pass the real number.
**Why:** The `StateGateway` interface is `(repo, issueNumber)`-keyed; rather than thread a `number | fileTarget` union through the recommender's ~8 call sites, the sentinel keeps the numeric signature and the router resolves file vs gh per repo. Auto-dispatch enqueues by `epicRef` (string) so a slug dispatches; the recommender's in-flight rows source `epicRef` (added to `ActiveImplementationWorkflow`, selecting the migration-009 `epic_ref` column).

## Recommender file-mode run-enablement (live ranking = operator smoke)
**File(s):** `packages/core/src/config.ts` (`[epic_store]` parse), `recommender-run.ts` (file-mode gate), `workflows/recommender.ts` (prompt framing)
**Date:** 2026-06-03

**Decision:** Parse `[epic_store]` into `MiddleConfig.epicStore`; `resolveRecommenderOptions` no longer rejects a file-mode repo (uses sentinel `0`); the recommender prompt reframes for the file store (rank Epic files under `epics_dir`, rewrite `state_file`, refs are slugs) instead of pointing at a phantom `#0` issue; `surface` skips the gh comment for sentinel 0.
**Why:** Routing the recommender's state I/O is moot if the run can't even start for a file repo (the pre-existing `config.stateIssue?.number` gate blocked it — a constraint the gap didn't name). The wiring is unit/integration-tested (resolution returns ok + sentinel; prompt framing asserted). The recommender agent's *live ranking quality* over file Epics is verified by operator smoke, matching #190's "operator-only live smoke" precedent for file-mode dispatch — it can't be gated in CI (a live agent run).

## Re-key the Epic browse cache (repo, number) → (repo, ref) [migration 010]
**File(s):** `packages/dispatcher/src/db/migrations/010_epics_ref_key.sql`, `packages/dispatcher/src/epics-cache.ts`
**Date:** 2026-06-03

**Decision:** Rebuild the `epics` table keyed on `(repo, ref)` with `number` nullable + a new `ref` column; `refreshEpics` upserts by ref and routes through the routing Epic gateway; `readEpics` orders `number DESC, ref ASC` (github Epics newest-first, file Epics — null number — after). The old `if (e.number === null) continue;` skip is gone.
**Why:** A file-mode Epic has no GitHub number, so a numeric PK couldn't represent it — it was explicitly skipped, invisible in the dashboard. Ref-keying mirrors migration 009's `workflows.epic_ref` exactly (`ref = CAST(number AS TEXT)` backfill), so the two canonical-ref columns stay consistent. SQLite can't change a PK in place; the migration rebuilds the table (the runner disables FK enforcement around the loop for exactly this). `EpicListItem` was already ref-first (shipped in #190), so `refreshEpics` needed no gateway-shape change — just the routing gateway instead of hardcoded `ghGitHub`.

## Dashboard: render file Epics, gate in-dashboard dispatch
**File(s):** `packages/dashboard/src/wire.ts` (`EpicCard.ref`), `db-deps.ts` (`workflowForEpic` by `epic_ref`), `app/components/Epics.tsx`
**Date:** 2026-06-03

**Decision:** `EpicCard` carries `ref` + nullable `number`; the card renders via the existing `<EpicRef>` (a `#N` label or a `file://planning/epics/<slug>.md` link, shipped in #190); the workflow lookup keys on `epic_ref` (resolves both modes); the force-dispatch **button is disabled for a file Epic** with a title pointing at `mm dispatch <slug>`.
**Why:** The browse-visibility deliverable is "file Epics appear and are inspectable" — `<EpicRef>` already does the file:// rendering, so the work was plumbing `ref` through the wire + join. In-dashboard force-dispatch goes through a numeric route (`onDispatch(repo, number, adapter)`); a file Epic has no number, and threading a slug through that route is a separate capability (manual `mm dispatch <slug>` already works, per #190). Disabling the button with an explicit pointer is honest — visible but not falsely dispatchable. The ready-row join also switched from number-match to `ref`-match, so a file Epic's recommended-adapter pill works too.

## Self-review fixes (internal CodeRabbit pass)
**File(s):** `recommender-run.ts`, `epic-store/file-poll-gateway.ts`, `auto-dispatch.ts`, `state-issue/parser.ts`
**Date:** 2026-06-03

**Decision:** Three robustness fixes from an adversarial self-review before marking ready:
1. `dispatchRecommender` now forwards `opts.epicStore` into `RecommenderInput` — it was dropped, so the standalone-helper path always took the github prompt branch (the daemon path already forwarded it). Tested by capturing the on-disk prompt of a file-mode run.
2. `file-poll-gateway` discriminates file vs github by `epicFileExists` (the authoritative check `listIssueComments` already uses), not a `^\d+$` heuristic — so a numeric-named file Epic (`42.md`) resolves via `meta.pr` instead of being mistaken for github issue #42.
3. The ref regexes (`parseEpicRef` `#(\S+)`, `IN_FLIGHT_RE` `#([^*\s]+)`) match the actual ref grammar (delimited by space / `**`), not `[\w-]` — a file stem isn't constrained to kebab, and a dotted slug (`v1.2-rollout`) would otherwise truncate and break the round-trip invariant.
**Why:** Resolve-the-class within each finding's blast radius; each fix carries a failing-first test. The class was "ref-shape assumptions" — `[\w-]`/`^\d+$` heuristics for an unconstrained file-stem slug.
