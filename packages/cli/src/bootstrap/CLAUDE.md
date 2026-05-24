# bootstrap — local conventions

The skill-distribution model lives here and isn't obvious from any one file. Root `CLAUDE.md` wins on conflict.

## The four-copy skill model

A skill exists in four places; the first two are tracked in this repo and must stay **byte-identical**:

1. `packages/skills/<skill>/` — **canonical** source of truth (authored here).
2. `packages/cli/src/bootstrap-assets/skills/<skill>/` — the mirror `mm init` stamps.
3. `.claude/skills/<skill>/` — stamped into a target repo (Claude Code reads it).
4. `.codex/skills/<skill>/` — stamped into a target repo (Codex reads it).

Copies 3–4 are produced by `mm init` from copy 2; copies 1–2 are kept identical by tooling.

## Editing a skill — always re-sync

- Author in `packages/skills/` only, then run `bun run sync-skills` to update the mirror. Never hand-edit `bootstrap-assets/skills/` — it's generated.
- `skills-sync.ts` (`diffSkills` / `syncSkills`) is the mechanism: byte-for-byte comparison, copies added/changed files, deletes stale ones so a removed skill doesn't orphan in the mirror.
- The **pre-commit hook** (`scripts/hooks/pre-commit`) runs `sync-skills --check` and **fails the commit** on drift — this is the hard gate. `mm doctor` mirrors it as a `skills` warning (soft signal, so a stale mirror doesn't block `mm dispatch`).
- Paths in `skills-sync.ts` resolve from the module's own location, so the check inspects the *middle source tree* regardless of cwd — `mm doctor` run inside a target repo still checks middle's own skills, not the target's.

## Bootstrap is dependency-injected

`init.ts` / `uninit.ts` take a `BootstrapDeps` bundle (`deps.ts` provides `realDeps`: fs + git + gh). Keep side effects behind that seam so `mm init` stays unit-testable without touching the filesystem or network.
