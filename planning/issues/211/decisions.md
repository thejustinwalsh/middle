# Decisions — Issue #211 (multi-repo coordination)

Decisions worth more than two lines, captured as they were made. Distilled into PR
review comments before the PR is marked ready.

## #225 — resolution is a deterministic post-agent workflow step, not the agent's job
**File(s):** `packages/dispatcher/src/workflows/recommender.ts` (resolve-blockers step), `packages/dispatcher/src/blocker-resolution.ts`
**Date:** 2026-06-04

**Decision:** A new `resolve-blockers` step runs after `reapply-dispatcher-sections`
and before `verify-state-issue-parses`. The reclassification logic lives in a pure
module (`blocker-resolution.ts`) with the live-state lookups injected, so it's fully
unit-testable without a gateway.
**Why:** The audit's finding was "no *code* consumes `blockedItem.blocker`". The
recommender agent can't reliably resolve a cross-repo reference (it has no guaranteed
access to repo B, and an LLM judgment isn't a deterministic unblock). Making it a
deterministic step closes the hole reproducibly. Slotting it after the dispatcher
reapply means it reads the latest body; before verify means the reclassified body is
what gets validated.
**Evidence:** Mirrors the existing `reapply-dispatcher-sections` best-effort pattern
(skip on parse error, skip the write on a no-op).

## #225 — a closed blocker moves the item to Ready (not Needs-human); the agent re-ranks
**File(s):** `packages/dispatcher/src/blocker-resolution.ts`
**Date:** 2026-06-04

**Decision:** When a blocker closes, the item moves to `## Ready to dispatch` with a
best-effort row (accurate title + open sub-issue count from `listOpenEpics` when the
Epic is discoverable, else title via `getIssueState` + count 1). The "(or Needs human
input if its own criteria are now unmet)" branch of the AC is NOT implemented
deterministically.
**Why:** Deciding an Epic's own acceptance-criteria readiness is the recommender
*agent's* job, not deterministic code — it requires reading the Epic body/criteria.
The transient Ready row is corrected by the next full recommender run. The integration
test asserts the Ready transition, which this satisfies.
**Evidence:** AC for #225 integration test asserts "moves to ## Ready to dispatch".

## #225 — validator relaxed for cross-repo + annotated blockers (a schema change)
**File(s):** `packages/state-issue/src/validate.ts`, `schemas/state-issue.v1.md`
**Date:** 2026-06-04

**Decision:** `validate()` previously rejected any `#`-prefixed blocker that wasn't
exactly `#\d+`. Relaxed to accept an optional `<owner>/<repo>` prefix and an optional
trailing `(<title>)` / `(stale blocker: <ref>)` annotation; backticked/free-text
non-issue blockers stay exempt.
**Why:** Without this, the resolution pass's own annotated output (`#42 (title)`,
`acme/b#7 (stale blocker: …)`) would fail the verify step it feeds. The schema doc is
the source of truth, so it's updated in the same change.
**Evidence:** `validate.test.ts` cases for cross-repo / annotated / stale forms.

## #225 — integration test drives the engine once, ticks many (bunqueue singleton)
**File(s):** `packages/dispatcher/test/multi-repo-blockers.test.ts`
**Date:** 2026-06-04

**Decision:** The integration test registers the recommender workflow on ONE shared
`Engine` and calls `engine.start` per tick. An earlier draft created a fresh `Engine`
per tick and the workflow hung.
**Why:** bunqueue's embedded queue/worker share a process-singleton manager keyed by
the first dataPath (see `packages/dispatcher/CLAUDE.md`). A second engine in-process
cross-talks with the first; reusing one engine is the established pattern (mirrors
`recommender-workflow.test.ts`).
**Evidence:** dispatcher `CLAUDE.md` → "bunqueue lifecycle & the lock-token race".

## #226 — one collision helper, two callers; the guard runs before any write
**File(s):** `packages/dispatcher/src/repo-config.ts`, `packages/cli/src/bootstrap/init.ts`
**Date:** 2026-06-04

**Decision:** `assertNoRepoPathCollision(db, repo, path)` is the single guard.
`registerManagedRepo` calls it before its INSERT (so the daemon's `rememberRepoPath`
rejects too), and `mm init` calls it via an injected `checkCollision` hook in
`initRepo` *right after the slug resolves and before any file is written*.
**Why:** The AC requires "before writing anything" so a rejected init leaves no
half-scaffolded `.middle/`. `registerRepo` is wired late (after scaffolding) and is
best-effort, so it can't be the guard — hence a separate early hook. A `repo != ?`
filter keeps a same-slug re-register idempotent (the daemon re-registers a repo's path
on every dispatch; that must never self-collide).
**Evidence:** `init-collision.test.ts` asserts `.middle/acme-b.toml` is absent after a
rejected second init; `repo-config.test.ts` (a)/(b)/(c) cases.

## #226 — the dispatch route maps the collision class to 400, re-throws everything else
**File(s):** `packages/dispatcher/src/hook-server.ts`
**Date:** 2026-06-04

**Decision:** `#handleControlDispatch` wraps `startDispatch` in a try/catch that maps
`RepoPathCollisionError` → 400 (naming both repos + path) and re-throws any other
error.
**Why:** A shared-checkout collision is a client config error (this `repoPath` belongs
to another slug), not a server fault — 400, not 500. The catch is deliberately narrow
(`instanceof RepoPathCollisionError`) so a genuine engine failure is never masked as a
client error. (The "non-collision still fails" path is left to the code's narrowness —
an HTTP test of it is brittle because Bun resets the connection on an uncaught fetch
throw rather than returning 500.)
**Evidence:** `control-routes.test.ts` — collision → 400 with both slugs + path.

## #227 — stamp all due repos synchronously, THEN fan out (double-dispatch guard intact)
**File(s):** `packages/dispatcher/src/recommender-cron.ts`
**Date:** 2026-06-04

**Decision:** The pass now has two phases: (1) due-check + `markRecommenderRun` for
every due repo, synchronously with no intervening await; (2) fire the runs
concurrently behind a hand-rolled bounded pool (`maxConcurrentRepos`, default 4),
each under a `withTimeout` (`runTimeoutMs`, default 60s). A timeout/throw rolls that
repo's stamp back and logs; others are untouched.
**Why:** Stamping all due repos before any `await` preserves the existing
"overlapping tick can't double-dispatch" invariant *even under concurrency* — an
overlapping pass sees every fresh stamp before this one yields. A per-repo timeout is
what actually delivers the fix: a hung `gh`/state-write on repo A is abandoned (the
underlying promise is orphaned but no longer blocks) so repo B still runs.
**Evidence:** `recommender-cron-parallel.test.ts` — B hangs 5s, A+C (100/200ms)
succeed, the pass finishes <2s, B's stamp rolls back; a bounded-concurrency test
asserts `maxInFlight` never exceeds the cap.

## #227 — concurrency knobs are daemon-global; per-repo timeout is uniform per pass
**File(s):** `packages/core/src/config.ts`, `packages/dispatcher/src/main.ts`
**Date:** 2026-06-04

**Decision:** `max_concurrent_repos` + `run_timeout_seconds` are read from the
daemon's **global** config (`MIDDLE_CONFIG`), not per-repo policy. The cron applies
one timeout to every repo's run in a pass.
**Why:** Fan-out width and per-run timeout are properties of the *pass* (how many
repos run at once, how long any one may take), not of an individual repo's ranking
cadence — the daemon-global config is the natural home. The per-repo `[recommender]`
policy still owns `enabled`/`interval_minutes`/`agent_timeout_minutes`. The
"per-repo state-issue note" the AC mentions is satisfied by the existing log + the
rolled-back watermark (the cron has no state-issue writer of its own — adding one
would be new surface, deferred).
**Evidence:** `config.test.ts` parses both keys (present → set, absent → undefined).
