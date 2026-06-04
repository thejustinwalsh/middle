# Issue #208: feat(verify): Phase-12 live-smoke verification harness

**Link:** https://github.com/thejustinwalsh/middle/issues/208
**Branch:** middle-issue-208

## Goal
Close the file-mode trust gap with a verification harness: a deterministic
integration test that drives the **real** file-mode workflow on every commit, an
operator command (`mm verify-file-mode`) that runs it with a structured report,
a real-GitHub smoke (`--live`), and docs that tell operators what it proves.

## Approach
- **One shared runner, two consumers.** Extract `runFileModeSmoke()` into the
  dispatcher: it stands up a tmpdir git repo configured `epic_store="file"`,
  authors an Epic file, and drives the **real** `createImplementationWorkflow`
  (real engine, `createWorktree`, `parseEpicFile`/`renderEpicFile`, the real
  `makeDefaultPostQuestion` + `runFileWatcherTick`) through
  dispatch → park-on-question → answer-via-file-edit → resume → complete,
  returning structured per-section results (`{name, ok, ms, detail}[]`). The gh
  boundary is stubbed at `EpicGateway`'s PR/comment methods only. Both #212's CI
  test and #213's CLI command call this one runner — no re-implemented drive.
- **#212** is the `bun test` that calls the runner and asserts the deep
  invariants (row `completed`, worktree `<sub-issue id=1>` `[x]`, conversation
  has exactly one question + one answer, tmpdir cleaned up).
- **#213** is `mm verify-file-mode`, which runs the runner over its own throwaway
  fixture and prints a `mm doctor`-style report (one line per section, PASS/FAIL +
  wall-time, summary line; exit 0/1 with the failing section named last). Its
  integration test spawns the real CLI via `Bun.spawn` and asserts the report.
- **#214** is `mm verify-file-mode --live --repo <repo>`: the same loop against
  real GitHub via the daemon control plane — write Epic file, dispatch, await a
  draft PR, edit the answer block, await completion, assert the PR exists with
  the sub-issue checkbox flipped, then clean up (close PR + delete branch) on
  success / leave artifacts + print URLs on failure. Deterministic plumbing test
  stubs the gh + daemon boundary. The actual live-GitHub *evidence run* is the
  operator step the Epic itself acknowledges a headless run can't perform
  ("could not create a throwaway GitHub repo or spawn a real agent").
- **#215** documents the harness in `docs/dogfooding.md`, cross-links from
  `docs/operator.md` and `README.md`, and adds `docs-cross-link.test.ts` that
  boots the CLI (`mm verify-file-mode --help` exits 0) and greps every `mm <cmd>`
  in the docs back to a registered command.

## Phases (one per sub-issue)
1. **#212** — `live-smoke.test.ts` + the shared `runFileModeSmoke()` runner.
2. **#213** — `mm verify-file-mode` command + structured report + spawn test.
3. **#214** — `mm verify-file-mode --live` + deterministic plumbing test.
4. **#215** — docs + cross-link test.

## Files likely to change
- `packages/dispatcher/src/epic-store/file-mode-smoke.ts` (new) — the runner.
- `packages/dispatcher/src/index.ts` — export the runner.
- `packages/dispatcher/test/epic-store/live-smoke.test.ts` (new) — #212.
- `packages/cli/src/commands/verify-file-mode.ts` (new) — #213 + #214 command.
- `packages/cli/src/index.ts` — register `verify-file-mode`.
- `packages/cli/test/verify-file-mode.test.ts` (new) — #213 spawn test.
- `packages/cli/test/verify-file-mode-live.test.ts` (new) — #214 plumbing test.
- `docs/dogfooding.md`, `docs/operator.md`, `README.md` — #215.
- `packages/cli/test/docs-cross-link.test.ts` (new) — #215.

## Out of scope
- Putting `--live` in CI (operator-cadence by design — racy + token-costly).
- A scheduled weekly live run (separate hosting decision).

## Open questions
- **The live-GitHub evidence run (Epic AC #3 + #214's live criterion) needs a
  human operator.** A headless dispatch cannot stand up a throwaway GitHub repo
  and spawn a real coding agent that opens a real PR — the Epic context says as
  much. All *code* (incl. the `--live` command) and all *deterministic* tests
  will land green; the one-shot live evidence is the operator's post-merge step,
  documented in #215. If the PR-ready gate blocks on that criterion, it will be
  surfaced for operator action rather than faked.
