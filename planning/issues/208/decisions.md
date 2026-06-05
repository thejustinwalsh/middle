# Decisions — Issue #208 (Phase-12 live-smoke verification harness)

## One shared `runFileModeSmoke()` runner, two consumers
**File(s):** `packages/dispatcher/src/epic-store/file-mode-smoke.ts`
**Date:** 2026-06-04

**Decision:** Put the smoke drive in a single runner in the dispatcher package,
returning structured per-section results, and have both `#212`'s `bun test` and
`#213`'s `mm verify-file-mode` call it.
**Why:** `#213`'s AC explicitly allows "delegating to the integration fixture from
the sibling sub-issue". A second hand-rolled drive would be a parity hazard — the
exact failure the Epic exists to prevent. The runner lives in the dispatcher (not
the CLI) because it depends on dispatcher internals (`Engine`,
`createImplementationWorkflow`, the gateways, `runFileWatcherTick`); the CLI
already imports dispatcher internals.
**Evidence:** Precedent `file-dispatch-integration.test.ts` / `parity.test.ts`
both drive the real workflow; this consolidates that drive into a reusable seam.

## Resume via the real file-watcher, not a direct `engine.signal`
**File(s):** `packages/dispatcher/src/epic-store/file-mode-smoke.ts`
**Date:** 2026-06-04

**Decision:** The "answer" step writes a non-empty `<!-- middle:answer for=N -->`
block to the Epic file (via `writeEpicFile`), then drives `runFileWatcherTick`
(the real watcher) to detect it and fire the resume — rather than calling
`engine.signal(RESUME_EVENT)` directly like `parity.test.ts` does.
**Why:** `#212`'s framing is "resume-via-edit"; exercising the real watcher proves
the file-mode resume path end to end (mtime poll → open-question-with-answer
detection → `fireSignal` → flip to `resolved`), which is exactly the seam the
live gap left unproven. `engine.signal` would skip the watcher entirely.
**Evidence:** `watcher.ts` `runFileWatcherTick`; `main.ts` wires
`fireSignal: (id, p) => engine.signal(id, RESUME_EVENT, p)` — the runner mirrors it.

## Assert the worktree checkbox from a capture, because finalize destroys it
**File(s):** `packages/dispatcher/src/epic-store/file-mode-smoke.ts`
**Date:** 2026-06-04

**Decision:** The stub adapter flips `<sub-issue id=1>` to `[x]` in the worktree
on the resume drive and the runner captures the worktree Epic file content at
that moment; the assertion reads the capture.
**Why:** `finalize` calls `destroyWorktree` on a `completed` terminal, removing
the worktree directory — so a post-completion read of the worktree file would
find nothing. The capture is the faithful state the agent left behind. The Epic
file must be **committed** in the tmpdir repo first, or `git worktree add` (which
checks out HEAD) yields a worktree without the file.
**Evidence:** `implementation.ts` `finalize` (`if (finalState !== "waiting-human")
await destroyWorktree`); `worktree.ts` `destroyWorktree` rmSyncs the dir.

## `--live` evidence run is the operator step; headless ships code + deterministic tests
**File(s):** `packages/cli/src/commands/verify-file-mode.ts`
**Date:** 2026-06-04

**Decision:** Build the `--live` command and a deterministic plumbing test
(stubbed gh/daemon boundary), but treat the actual real-GitHub evidence run as a
human-operated step.
**Why:** The Epic context states a headless run "could not create a throwaway
GitHub repo or spawn a real agent" — the live run fundamentally needs a real
coding agent to open a real PR. Faking the evidence would re-create the very
trust gap this Epic closes.
**Evidence:** Epic #208 "Context"; the deferred-smoke notes in PR #198/#207.
