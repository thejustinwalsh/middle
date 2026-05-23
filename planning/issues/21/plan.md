# Epic #21: Bootstrap commands, skills, and state issue

**Link:** https://github.com/thejustinwalsh/middle/issues/21
**Branch:** middle-issue-21

## Goal
Deliver Phase 3 of the build spec — the dogfooding crossover. `mm init`/`mm uninit`
transactionally bootstrap (and reverse) middle into a target repo: skills, hooks,
per-repo config, a schema-conforming state issue, and gitignore updates. The
dispatcher gains the ability to read and write its three owned sections of the
state issue. Finally, middle is bootstrapped into its own repo.

## Approach
- Build bottom-up so each phase rests on a verified one: skills assets first
  (they're what `mm init` stamps), then `mm init`/`mm uninit`, then state-issue
  creation inside init, then dispatcher↔state-issue integration, then the
  dogfooding run.
- Reuse existing building blocks: `@middle/state-issue` (`parseStateIssue`,
  `renderStateIssue`), `@middle/core` config loader + `HOOK_SH`, the
  `installHooks` pattern from the claude adapter, and the `Bun.spawn` shell-out
  conventions already in the CLI.
- TDD per `superpowers:test-driven-development`: scratch-repo + temp-dir tests
  for the filesystem/transactional behavior; in-process gh shelling is wrapped
  behind a thin, injectable seam so tests don't hit GitHub.
- Keep the canonical `packages/skills/` and the `bootstrap-assets/` mirror
  byte-identical, enforced by a committed sync script + pre-commit hook + a
  `mm doctor` drift check.

## Phases (one per sub-issue)
1. **#23 Skills** — `packages/skills/{implementing,recommending}-github-issues/`,
   byte-identical `packages/cli/src/bootstrap-assets/skills/` mirror, a sync
   script, a committed pre-commit hook (+ `bun run` installer), and a `mm doctor`
   drift check.
2. **#22 mm init / mm uninit** — transactional bootstrap + reversal, `--dry-run`,
   tests over a scratch git repo (fresh install, re-init, uninit).
3. **#24 State issue creation** — `mm init` creates the `agent-queue:state` label
   + state issue with an empty schema-conforming body and writes its number back
   into `.middle/config.toml`.
4. **#25 Dispatcher integration** — read the state issue via `gh`, parse it,
   re-render only In-flight / Rate limits / Slot usage, write back while keeping
   recommender-owned sections byte-identical.
5. **#26 Dogfooding crossover** — `mm init .` on middle itself; verify
   `.middle/` layout, installed skills/hooks, the live state issue, and a working
   `mm dispatch`.

## Files likely to change / add
- `packages/skills/implementing-github-issues/{SKILL.md,references/...}` — canonical copy
- `packages/skills/recommending-github-issues/SKILL.md` — new skill text
- `packages/cli/src/bootstrap-assets/skills/**` — byte-identical mirror
- `scripts/sync-skills.ts`, `scripts/hooks/pre-commit` — sync + drift enforcement
- `packages/cli/src/commands/{init,uninit}.ts` + `index.ts` wiring — new commands
- `packages/cli/src/bootstrap/*` — staging, hook-config, gitignore, state-issue helpers
- `packages/dispatcher/src/state-issue.ts` (+ a `gh` seam) — dispatcher read/write
- `packages/cli/src/commands/doctor.ts` — skills-drift check
- tests alongside each

## Out of scope
- Recommender producing the full body (Phase 7)
- Dashboard reads of parsed state (Phase 9)
- Full `mm doctor` (Phase 11) — only the drift hook point here
- Skill enforcement gates (Phase 4)

## Open questions / risks
- **#26 has irreversible external side effects** (creates a real `agent-queue:state`
  issue + label on `thejustinwalsh/middle`, runs a real `mm dispatch`) and touches
  `.middle/`, which is middle's operational dir for the in-flight dispatch. The
  engineering (the `mm init` capability) is fully built and verified against a
  scratch repo in phases #22–#25; whether the autonomous run performs the *live*
  crossover on the real repo mid-PR vs. leaving that one operator action for
  merge time is a judgement call I'll resolve when I reach #26, with the working
  command in hand.
