# Decisions — Issue #209 (operator docs hardening)

## #218 — `--foreground` runs the daemon in-process via a dynamic import + a test seam
**File(s):** `packages/cli/src/commands/start.ts` (`runForegroundDaemon`, `defaultRunForeground`)
**Date:** 2026-06-04

**Decision:** `mm start --foreground` skips `runStart`'s fork/pid-file path entirely
and runs `runDaemon({ hostExtras: dashboardHostExtras })` in *this* process. The
daemon entry is pulled in with a **dynamic** `import()` (so the default background
path never loads the dashboard/daemon modules), and the runner is injectable via a
`runForeground` seam so unit tests don't boot the real daemon.

**Why:** A service manager (systemd `Restart=on-failure`, launchd `KeepAlive`) owns
the lifecycle, so middle must not daemonize behind its back or leave a pid file the
manager doesn't track. `runDaemon` already installs SIGTERM/SIGINT → drain →
`process.exit(0)` (`main.ts:1027-1030`), so foreground mode gets clean shutdown for
free. The seam keeps the two unit tests fast while the integration test boots the
real binary.

**Evidence:** `daemon-entry.ts` runs exactly `runDaemon({ hostExtras })` under
`import.meta.main`; `main.ts:118-138` shows the daemon boots from just config + db
(no tmux/gh needed at boot), which is why the integration test can spawn it with a
temp HOME + `MIDDLE_CONFIG`.

## #218 — the integration test boots the real `mm` binary, not a mocked daemon
**File(s):** `packages/cli/test/start-foreground.test.ts`
**Date:** 2026-06-04

**Decision:** Beyond the two fast injected-seam unit tests, the integration test
`Bun.spawn`s `bun src/index.ts start --foreground` against an isolated `HOME` + a
temp config (temp db_path + port 41877), polls `/health` until ready, asserts **no**
`~/.middle/dispatcher.pid` is written, sends `SIGTERM`, and asserts a clean exit 0.

**Why:** The sub-issue's integration criterion requires proving the systemd/launchd
templates work "without manual workarounds" — that demands actually booting the
daemon in foreground and observing the pid-file absence + SIGTERM handling on the
real process, not a mock. Isolating `HOME` keeps it off the real `~/.middle`; a high
port avoids colliding with a running dispatcher on 4120. Runs in ~1.6s.

## #217 — the integration check is a docs↔code drift guard, not a recommender replay
**File(s):** `packages/cli/src/commands/doctor.ts` (`runVocabularyCheck`)
**Date:** 2026-06-04

**Decision:** Realize #217's "the check exits 0 only when the docs and the code
agree" as `mm doctor --vocabulary-check` — parse `docs/vocabulary.md`, list its
labels, and assert (a) every label middle's code deterministically keys on (the
`NEEDS_DESIGN_LABEL` and `STATE_LABEL` constants + the middle-owned
`NON_FEATURE_LABELS`, excluding generic GitHub triage labels) is documented, and
(b) the full canonical vocabulary is present (catches a deleted section). Test it
in the CLI suite (`packages/cli/test/doctor.test.ts`), booting the real `mm` binary
via `Bun.spawn` for the integration evidence.

**Why:** The sub-issue's literal wording wanted a test that "exercises each
documented label against a fixture state issue and asserts the recommender's
classification matches." But the recommender's classification is **LLM-driven** —
`recommender.ts` assembles a prompt and the agent (via the skill) classifies; there
is no deterministic classifier in code to assert against (confirmed: no label
branching in `workflows/recommender.ts`; `setEpicStoreConfig`-style label handling
is limited to the `NEEDS_DESIGN_LABEL`/`STATE_LABEL` constants and the rubric's
`NON_FEATURE_LABELS`). A non-deterministic LLM assertion would be flaky and prove
nothing. The honest, enforceable equivalent of "docs and code agree" is to assert
the doc covers every label the code *actually* keys on — a real drift guard with
teeth: rename a constant or add a new keyed label without documenting it and the
check fails. The issue explicitly authorized "an extended `mm doctor` flag", and
the doc-honors-the-vocabulary intent is fully served.

**Why the CLI suite, not `packages/dispatcher/test/workflows/recommender.test.ts`:**
that path doesn't exist (the recommender test is `recommender-workflow.test.ts`),
and the drift guard lives in `mm doctor` (CLI), so its test belongs beside it. The
integration evidence is the `Bun.spawn` boot of the real CLI against the shipped doc.

**Evidence:** `packages/dispatcher/src/workflows/recommender.ts` (prompt assembly,
no label classification); `packages/core/src/integration-rubric.ts:79-96`
(`NON_FEATURE_LABELS`/`isFeatureIssue`); `packages/cli/src/bootstrap/types.ts:6`
(`STATE_LABEL`); `packages/cli/src/commands/audit-issues.ts:12` (`NEEDS_DESIGN_LABEL`).

## #217 — skills cross-link with an absolute GitHub URL, not a relative path
**File(s):** the three skills' `SKILL.md`
**Date:** 2026-06-04

**Decision:** The skill cross-links to `docs/vocabulary.md` use the absolute URL
`https://github.com/thejustinwalsh/middle/blob/main/docs/vocabulary.md`.

**Why:** Skills are stamped into *target* repos (`.claude/skills/`, `.codex/skills/`
via the `bootstrap-assets` mirror). A relative `../../docs/vocabulary.md` resolves
in the middle repo but is broken everywhere middle is installed. The vocabulary is
middle's own (the labels middle's recommender/dispatcher key on), so the canonical
middle URL is correct from any repo. Red-flag *table* entries were left in place
(action-shaped, per the sub-issue); only definition-shaped prose became a cross-link.

## #216 — flip-existing-repo is `mm init --epic-store=file`, not a hand TOML edit
**File(s):** `docs/operator.md` (Enable file mode section)
**Date:** 2026-06-04

**Decision:** Document the existing-repo flip as re-running `mm init <repo>
--epic-store=file`, and explicitly warn that hand-editing `.middle/<slug>.toml`
alone does **not** switch modes.

**Why:** The issue's acceptance framed it as "(a) the TOML edit … in
`.middle/<slug>.toml`" for existing repos vs "(c) the flag for new repos". But the
code reality (per `packages/core/src/config.ts` `EpicStoreSettings` docstring and
the absence of any toml→db re-sync) is that `mm init` writes **two** things that
must agree: the toml copy (read by config-only callers like the recommender-run
resolution, #200) **and** the `repo_config.epic_store` db row (read by the
dispatcher's per-repo gateway router, `readEpicStoreConfig`). `setEpicStoreConfig`
is called only from the `mm init` CLI wrapper (`index.ts` → `setEpicStoreInDaemonDb`)
— nothing re-derives the db row from the toml at daemon boot or dispatch. So a
toml-only edit would flip ranking but not dispatch routing — a silent half-switch.
`mm init` is explicitly idempotent ("that's the point of a re-init") and its
file-mode path scaffolds the dirs + writes both the toml and the db row, preserving
committed `policy.toml`. Documenting the accurate single command is safer than
reproducing the issue's slightly-off premise.

**Evidence:** `packages/core/src/config.ts:103-117` (the "writes both" docstring);
`packages/cli/src/commands/init.ts:30-38` (`setEpicStore` "called for every mode …
so a re-init can flip the mode"); `packages/cli/src/bootstrap/init.ts:95-96,117-123`
(re-init refreshes + file-mode scaffold).

## #216 — doctor's file-mode check extended to three rows (epics_dir, state_file, round-trip)
**File(s):** `packages/cli/src/commands/doctor.ts` (`checkEpicStore`, `checkEpicFilesRoundTrip`)
**Date:** 2026-06-04

**Decision:** `checkEpicStore` now returns `Check[]` and, in file mode, emits three
rows: `epics_dir` exists, `state_file` present, and `epic-files` (every Epic file
under `epics_dir` parses + renders byte-identically). Only files opening with
`<!-- middle:epic v1 -->` are round-tripped; the scaffold's `README.md` and other
non-Epic markdown are skipped, not failed.

**Why:** The sub-issue's integration criterion requires doctor to "run the file-mode
checks (epics_dir exists, state_file present, parser+renderer round-trip the example
Epic file)". The prior check only verified `epics_dir`. Returning `Check[]` keeps each
sub-check as its own pass/warn/fail row (granular operator output) rather than
collapsing them into one ambiguous line. Skipping non-marker files avoids a false
failure on the `README.md` the file-mode scaffold itself writes (which is not an
Epic and would throw on `parseEpicFile`).

**Evidence:** `parseEpicFile` throws a named-marker error on malformed bodies
(`epic-file/parser.ts:18-31`); the byte-identical round-trip is the load-bearing
file-mode invariant (`epic-file/parser.ts:24-27`).

## #216 — the doctor test lifts its fixture from the doc, not a hard-coded copy
**File(s):** `packages/cli/test/doctor.test.ts` (`doctor honors the documented file-mode config`)
**Date:** 2026-06-04

**Decision:** The test extracts the worked-example Epic file straight out of
`docs/operator.md` (the fenced block opening with the Epic doc marker) and uses it as
the doctor fixture, then also asserts that example round-trips.

**Why:** The criterion says the test "uses the worked example from the docs as its
fixture". Lifting it from the doc (rather than duplicating it in the test) makes the
test a drift guard: edit the doc's example into something that no longer parses, or
delete the section, and this test fails — docs and code can't silently diverge.
