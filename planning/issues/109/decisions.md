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
#113 wires the daemon's server with engine/hub/version the same way.

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
