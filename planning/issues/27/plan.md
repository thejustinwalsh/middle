# Issue #27: Skill enforcement gates (Epic)

**Link:** https://github.com/thejustinwalsh/middle/issues/27
**Branch:** middle-issue-27

## Goal
Turn the implementer skill's advisory "principles" into mechanically-enforced gates that
react to the agent's outputs: a plan-comment guard, a PR-ready guard, a checkbox-revert
reconciler, and a positive done-signal requirement. The gates observe and react — they never
interfere with the agent's reasoning. Per the dogfooding rule, they fire on middle's own PRs.

## Approach
- Each gate is a **pure, dependency-injected evaluator** in `packages/dispatcher/src/gates/`,
  tested in isolation against in-memory stubs. GitHub access goes behind a narrow
  `GitHubGateway` seam (`packages/dispatcher/src/github.ts`) modeled on the existing
  `StateIssueGateway` (gh-CLI-backed `run()` helper).
- The PR-ready guard is a `PreToolUse` hook (`pr-ready-gate.sh`, single-sourced in
  `@middle/core` like `HOOK_SH`) that forwards the hook payload to a new dispatcher endpoint
  `POST /gates/pr-ready`. The dispatcher does the `gh pr ready` matching + criteria evaluation
  in testable TS; the shell stays dumb (HTTP 200 = allow/exit 0, deny = exit 2 with reason on
  stderr, dispatcher-unreachable = fail-open).
- The done-signal change is localized to the `launch-and-drive` drive loop: a `bare-stop`
  resolves through a bounded nudge loop gated on a positive PR-ready check; it never maps
  straight to `completed`.
- TDD throughout: every evaluator and the endpoint get a failing test first.

## Phases (one per open sub-issue)
1. **#28 Plan-comment guard** — after the plan phase, verify a comment by the agent's account
   on the Epic contains the plan body; otherwise fail with
   `Plan-comment guard: no plan comment found on Epic #N`.
2. **#29 PR-ready guard** — `PreToolUse` hook matches `gh pr ready`, calls `/gates/pr-ready`;
   the dispatcher walks the Epic PR's acceptance criteria (union of sub-issues), requiring each
   to carry an evidence link OR a `(deferred: <comment-url>)` annotation by a non-bot user;
   returns allow / deny-with-reason.
3. **#30 Checkbox-revert reconciler** — after each push, inspect the Epic PR's Status checkbox
   list (one `#N` per sub-issue); for a `[ ] → [x]` transition, run sub-issue N's verification
   gates (injected runner; real runner is Phase 6); on failure revert the checkbox and comment.
4. **#80 Positive done-signal** — a `bare-stop` no longer finalizes as `completed`; completion
   requires a ready, non-draft Epic PR. Otherwise nudge (bounded), then park in `waiting-human`.

## Files likely to change / add
- `packages/dispatcher/src/github.ts` (new) — `GitHubGateway` seam + `ghGitHub` impl.
- `packages/dispatcher/src/gates/plan-comment.ts` (new) — `verifyPlanComment`.
- `packages/dispatcher/src/gates/pr-ready.ts` (new) — `parseAcceptanceCriteria`, `evaluatePrReady`.
- `packages/dispatcher/src/gates/checkbox-revert.ts` (new) — `parseStatusCheckboxes`, `reconcileCheckboxes`.
- `packages/dispatcher/src/hook-server.ts` — add `POST /gates/pr-ready` route + injected gate dep.
- `packages/dispatcher/src/workflows/implementation.ts` — bounded nudge loop + positive done-signal.
- `packages/core/src/hook-script.ts` (or sibling) — `PR_READY_GATE_SH` constant.
- `packages/adapters/claude/src/hooks.ts` — install the gate script + register the extra PreToolUse command.
- `packages/dispatcher/test/gates/*.test.ts`, `hook-server-gates.test.ts`, extend `implementation-workflow.test.ts`.

## Out of scope
- The full multi-step workflow (`plan` / `implement-loop` / branch paths) — those land in other
  phases; the gates are built as standalone, wired into the current minimal workflow where they fit.
- The verification-gate **runner** itself (Phase 6) — #30 injects it; real execution integrates later.
- The hook *installation mechanism* (Phase 2) — #29 only adds a newly-matched event.
- middle never merges; terminal state is PR ready-for-review.

## Open questions
- None blocking. Status-checkbox→sub-issue mapping is resolved by requiring a `#N` issue
  reference on each Status line (documented in decisions.md); this PR's own Status section
  follows that convention.
