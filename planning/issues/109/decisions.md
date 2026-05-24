# Issue #109 — decisions log

Source for the PR review comments (Phase 8). Append as decisions are made.

## Bottom-up phase ordering; standalone path deleted last
**File(s):** whole epic
**Date:** 2026-05-24

**Decision:** Land the 6 sub-issues bottom-up — factory (#110) → EventHub (#111)
→ routes (#112) → daemon wiring (#113) → client (#114) → delete standalone path
(#115).
**Why:** Each phase is then a small, independently-verifiable diff, and the
risky deletion (#115) lands only after its replacement (the daemon engine + the
thin client) is proven green. Deleting first would leave the tree broken across
several phases.
**Evidence:** The Epic plan comment prescribes this order; matches the repo's
"rebase, atomic commits" convention.

## buildImplementationDeps breaks the gate↔server↔deps cycle with a `bindServer` callback
**File(s):** `packages/dispatcher/src/build-deps.ts`
**Date:** 2026-05-24

**Decision:** `buildImplementationDeps(args)` returns `{ deps, prReadyGate }`. The
caller supplies `bindServer(prReadyGate) => { sessionGate, dispatcherUrl }`; the
factory builds the gate, hands it to `bindServer` (which does
`new HookServer(store, prReadyGate)` + `.start()`), and uses the returned live
`SessionGate` + localhost URL to assemble `deps`.
**Why:** `prReadyGate` is a factory *output*, but `deps.sessionGate` is the
HookServer which is constructed *from* `prReadyGate` — a genuine value cycle.
Alternatives: (a) pass `sessionGate` as an input — impossible, it doesn't exist
until the gate does; (b) mutate `deps.sessionGate` after — needs a placeholder,
dishonest types; (c) return a `buildDeps(sessionGate)` finisher — violates the
mandated `{ deps, prReadyGate }` shape. `bindServer` keeps the shape, keeps
`new HookServer` in the caller, resolves the **ephemeral-port** dispatcherUrl
post-`start()`, and stays engine-free (testable without bunqueue).
**Evidence:** dispatch.ts:122-191 builds gate→server→deps in exactly that order;
PR #113 wires the daemon's server with engine/hub/version the same way.

## agentLogin resolved inside the factory via an injectable resolver
**File(s):** `packages/dispatcher/src/build-deps.ts`
**Date:** 2026-05-24

**Decision:** The factory takes `resolveAgentLogin?: () => Promise<string|undefined>`
(default = the real `gh`-backed one) and awaits it, rather than taking a resolved
`agentLogin` string.
**Why:** Keeps the factory legitimately `async` (per #110 wording "the awaited
resolveAgentLogin()"), resolves the login exactly once per build, and lets tests
inject a stub so no `gh` shell-out happens in unit tests. #113's "main resolves
once" is still satisfied — it's resolved once, inside the shared factory.

## Daemon is multi-repo: a per-repo checkout registry feeds resolveRepoPath
**File(s):** `packages/dispatcher/src/main.ts`
**Date:** 2026-05-24

**Decision:** The daemon keeps an in-memory `Map<repoSlug, repoPath>` populated by
`/control/dispatch` (the body carries `repoPath`). `resolveRepoPath(repo)` reads
it; a missing entry throws. The map is in-memory — parked execs don't survive a
daemon restart anyway (deferred durability, #116).
**Why:** `buildImplementationDeps` bakes a single `resolveRepoPath`, but the
daemon hosts dispatches for any repo and learns each checkout's path only from
its dispatch request. A registry keyed by the repo slug (what the workflow passes
to `resolveRepoPath`) is the minimal correct seam.

## The PR-ready gate's comment-author repo comes from the comment URL, not a baked slug
**File(s):** `packages/dispatcher/src/github.ts`, `build-deps.ts`
**Date:** 2026-05-24

**Decision:** `getCommentAuthor` derives `owner/repo` from the comment URL itself
(the URL already encodes it), falling back to the passed `repo` only when the URL
lacks it. `buildImplementationDeps.repoSlug` becomes optional (the daemon passes
none).
**Why:** A single daemon serves many repos, so a baked `repoSlug` for the gate's
deferral-author check is wrong for all but one. The comment URL is authoritative
about which repo a comment lives in, so deriving from it is both correct and
multi-repo-safe — and removes the need for the daemon to know a repo at startup.
A wrong repo previously failed safe (404 → deny), but URL-derivation is simply
correct.

## installBunqueueRaceSwallower moves to its own module (survives #115)
**File(s):** `packages/dispatcher/src/bunqueue-race.ts`
**Date:** 2026-05-24

**Decision:** Move `installBunqueueRaceSwallower` (+ its regex) out of `dispatch.ts`
into `bunqueue-race.ts`; `dispatch.ts`, `recommender-run.ts`, and the daemon all
import it from there. The daemon installs it at startup and removes it on shutdown.
**Why:** #113 requires the swallower in the daemon's lifecycle path, and #115
guts `dispatch.ts`'s engine path. A standalone home keeps the swallower (still
used by `recommender-run.ts`'s ephemeral engine) from being lost when `dispatchEpic`
is deleted. `waitForSettle` is extracted to `engine-settle.ts` (shared by
`recommender-run.ts`); `dispatch.ts` is removed entirely with the standalone path.

## Hybrid SSE source: engine.onAny (bunqueue states) + an updateWorkflow observer (DB-only states)
**File(s):** `packages/dispatcher/src/main.ts`, `workflow-record.ts`
**Date:** 2026-05-24

**Decision:** Broadcast `{type:"workflow", data:{id,repo,epic,state}}` from two
sources: `engine.onAny` for bunqueue lifecycle states (running/waiting/completed/
failed/compensating), and a module-level `setUpdateWorkflowObserver` hook on
`updateWorkflow` for middle's DB-only states (launching, waiting-human,
rate-limited, compensated)
that bunqueue never emits. Both go through one `broadcastWorkflow(id, state)`
that looks up repo/epic from the row.
**Why:** Neither source alone is complete — bunqueue doesn't know middle's
`waiting-human`, and the DB observer doesn't see bunqueue's own `running`/`waiting`
transitions. The client (#114) needs the park signal (`waiting-human`) to exit 0,
so the DB observer is load-bearing. Duplicate states across sources are harmless
(the client exits on the first terminal/park it sees).

## Client subscribes to /control/events BEFORE POSTing /control/dispatch (review round 1)
**File(s):** `packages/cli/src/commands/dispatch.ts`
**Date:** 2026-05-24

**Decision:** `runDispatch` opens the SSE stream first, then POSTs the dispatch,
then follows the stream filtered to the returned `workflowId`.
**Why:** An internal review caught a hang: a fast-failing workflow emits its
terminal frame on the next tick, and `/control/events` init-replay omits terminal
states (`listNonTerminalWorkflows`). A subscribe-after-POST races that frame —
broadcast to zero subscribers, never replayed — and the client then blocks
forever (the 15s heartbeat keeps the stream from ending). Subscribing first
guarantees the terminal frame is delivered. A regression test pins the GET-before-POST
order via the fake daemon.

## broadcastWorkflow collapses consecutive identical (id, state) frames (review round 1)
**File(s):** `packages/dispatcher/src/main.ts`, `packages/dispatcher/CLAUDE.md`
**Date:** 2026-05-24

**Decision:** Track the last broadcast state per execution id; skip a repeat.
**Why:** The two SSE sources overlap on `completed` (the workflow writes it to
the row → observer, AND bunqueue emits `workflow:completed` → onAny), so a normal
completion double-broadcast. The client is idempotent, but the dashboard (#57)
would see dupes. The CLAUDE.md "disjoint sources" claim was inaccurate and is now
corrected to document the union vocabulary + the de-dup.
