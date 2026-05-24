# Decisions — Issue #83

## Bootstrap is data-driven; no code changes to the pipeline
**File(s):** `packages/cli/src/bootstrap/skills-sync.ts`, `assets.ts`, `uninit.ts`, `commands/doctor.ts`, `scripts/sync-skills.ts`
**Date:** 2026-05-23

**Decision:** Add `creating-github-issues` purely as *data* (a new canonical skill dir + re-synced mirror + stamped copies), with no changes to the bootstrap/sync/stage/uninit/doctor code.
**Why:** Every stage of the pipeline enumerates directories rather than listing skill names:
- `listSkillDirs(canonicalDir)` (sync, doctor) — immediate subdirs of `packages/skills/`.
- `unionSkillFiles` unions skill dirs from *both* canonical and mirror trees.
- `listBootstrapSkills()` (stage, uninit) — immediate subdirs of the mirror.
- `stageSkills` loops `listBootstrapSkills()` × `[".claude", ".codex"]`; `uninitRepo` mirrors that loop.
- `mm doctor`'s `checkSkillsDrift` calls the same generic `diffSkills`.
Adding the canonical dir + re-syncing therefore propagates the new skill through init, uninit, drift-check, and the pre-commit hook automatically.
**Evidence:** Read all five files end-to-end; no string literal of any skill name appears in the pipeline (only in tests/README).

## Source content = repo's live `.claude` copy
**File(s):** `packages/skills/creating-github-issues/SKILL.md`
**Date:** 2026-05-23

**Decision:** Copy the canonical body verbatim from `.claude/skills/creating-github-issues/SKILL.md` (487 lines), no content edits.
**Why:** Issue #83 "Out of scope" explicitly forbids changing the skill's content. The repo's live copy is byte-identical to the operator's `~/.claude/skills/` copy (verified via `diff -q`), so it's the authoritative text. The skill ships as a single `SKILL.md` with no `references/` subdir (unlike `implementing-github-issues`), which the recursive sync/stage handle transparently.

## Self-bootstrap parity: add the missing `.codex` stamped copy
**File(s):** `.codex/skills/creating-github-issues/SKILL.md`
**Date:** 2026-05-23

**Decision:** Stamp the skill into this repo's own `.codex/skills/` so all four tracked copies (canonical, mirror, `.claude`, `.codex`) are byte-identical — middle is bootstrapped into itself.
**Why:** Before this change `.claude/skills/creating-github-issues/` existed but `.codex/skills/creating-github-issues/` did not, an asymmetry that `mm init` would otherwise fix on a real target repo. Keeping the self-bootstrap honest means the repo reflects what `mm init` produces.
