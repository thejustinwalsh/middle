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
