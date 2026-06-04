# Issue #209: Operator docs hardening (file mode flip, vocabulary, daemon-as-service)

**Link:** https://github.com/thejustinwalsh/middle/issues/209
**Branch:** middle-issue-209

## Goal
Ship three operator-facing docs that close the three concrete gaps the docs audit
found — enabling file mode on an existing repo, the full label vocabulary, and
running the daemon as a system service that survives a reboot — each backed by a
real integration test so the docs can't silently drift from the code.

## Approach
- One Epic → one branch → one PR. Each of the three open sub-issues is a phase.
- Docs follow `docs/operator.md` voice + Diátaxis (how-to, not tutorial/explanation).
- Each phase carries a **real-path integration test** as its done-evidence — not
  unit-only — per the integration-verified definition of done.
- All commands copy-pastable and exact; every placeholder backed by a worked example.
- Keep `docs/vocabulary.md` the single source of truth; the three Epic-aware skills
  cross-link to it instead of re-stating label rules (red-flag entries stay).

## Phases (one per sub-issue)
1. **#216 file-mode walkthrough** — `docs/operator.md` gains "Enable file mode on an
   existing repo" (TOML edit, dir layout, `mm init --epic-store=file`, a 5-line worked
   Epic file + its dispatch, operator-visible differences). Integration: extend
   `packages/cli/test/doctor.test.ts` with `doctor honors the documented file-mode
   config` — `mm doctor` against a `.middle/<slug>.toml` written exactly as the docs
   specify boots the CLI, runs the file-mode checks, and exits 0, using the doc's
   worked-example Epic file as the fixture.
2. **#217 vocabulary doc** — `docs/vocabulary.md`, one section per label
   (`epic`, `approved`, `needs-design`, `blocked`, `wontfix`, `agent:claude`,
   `agent:codex`, `agent-queue:state`, `agent-queue:eligible`, `dogfood`,
   `bootstrap`, `housekeeping`, `phase:N`): meaning, who applies, middle's response,
   when (not) to use. The three skills replace inline label-definition prose with a
   one-line cross-link (red-flag table entries stay — action-shaped). Integration:
   `mm doctor --vocabulary-check` boots the CLI, parses `docs/vocabulary.md`, and
   asserts the doc agrees with the authoritative label constants the code keys on
   (`NEEDS_DESIGN_LABEL`, `STATE_LABEL`, `NON_FEATURE_LABELS`, eligible marker) —
   exits 0 only when docs and code agree. Tested in the CLI suite (boots the real CLI).
3. **#218 daemon-as-a-service** — `docs/daemon-as-a-service.md` (complete systemd
   unit + launchd plist + install/verify/log-tail commands). Add `mm start
   --foreground` (skip the PID-file fork; run the daemon in-process so the service
   manager owns lifecycle; honor SIGTERM). Cross-link from `docs/operator.md`
   "Start and stop" and README's setup steps. Integration:
   `packages/cli/test/start-foreground.test.ts` spawns `mm start --foreground` via
   `Bun.spawn`, confirms it stays running, asserts no `~/.middle/dispatcher.pid`,
   and SIGTERM is honored cleanly.

## Files likely to change
- `docs/operator.md` — new file-mode section + foreground/service cross-links
- `docs/vocabulary.md` — new (label single source of truth)
- `docs/daemon-as-a-service.md` — new (systemd + launchd)
- `README.md` — link the daemon-as-service doc after `mm doctor` in setup
- `packages/cli/src/commands/start.ts`, `packages/cli/src/index.ts` — `--foreground`
- `packages/cli/src/commands/doctor.ts`, `packages/cli/src/index.ts` — `--vocabulary-check`
- `packages/cli/test/doctor.test.ts` — file-mode-config-honored assertion
- `packages/cli/test/start-foreground.test.ts` — new
- `packages/skills/{creating,recommending,implementing}-github-issues/SKILL.md` — cross-links

## Decision note (recorded in decisions.md)
Issue #217's integration is realized as a **docs↔code drift guard** via `mm doctor
--vocabulary-check`, not a deterministic replay of the recommender's *classification*:
the recommender's classification is LLM-driven (it assembles a prompt; the agent
classifies), so there is no deterministic classifier to assert against. The honest,
enforceable equivalent of "the check exits 0 only when docs and code agree" is to
assert every label the **code** deterministically keys on is documented as the code
behaves. The issue explicitly authorizes "an extended `mm doctor` flag".

## Out of scope
- Windows service templates; Docker/containerized deployment (sibling-noted out of scope)
- Changing recommender/dispatch behavior — docs + a drift guard only

## Open questions
- None blocking. The recommender-classification-vs-drift-guard call is resolved above
  and recorded in decisions.md; it's an engineering judgment, not a >3-fork design gap.
