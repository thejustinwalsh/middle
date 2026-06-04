# Decisions — Issue #209 (operator docs hardening)

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
