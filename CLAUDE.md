# middle — contributor & agent guide

`middle` autonomously dispatches coding agents against GitHub issues. The authoritative design lives in `planning/middle-management-build-spec.md` — read it for the architecture, build sequence, adapter interface, and state-issue schema. This file is the working-convention summary every contributor and every dispatched agent must follow.

## Git commits

- **Never** add a `Co-Authored-By` trailer for Claude / the assistant / any AI, and no "Generated with …" lines. Plain commit messages only.
- Commit messages and PR titles follow **Conventional Commits**: `feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`, `test(scope): …`.
- Use the repository's configured git identity. Don't pass `-c user.name=…` / `-c user.email=…` overrides.
- We rebase, we don't squash — keep history atomic and meaningful. Sync against `main` as you go, and enable `git rerere` (`git config rerere.enabled true`) so conflict resolutions replay instead of being re-earned. Rebase is the default; when `main` has re-architected the same code your branch did and a per-commit rebase keeps re-conflicting on the same hunks, switch to a single `git merge origin/main` resolved **new-work-as-base** (start from your branch's version, re-apply main's edits on top), then re-verify. See `implementing-github-issues` → "Keeping the branch mergeable into main".

## Issue & PR workflow

middle's dispatch unit is an **Epic** — one Epic = one branch = one PR. The Epic's open sub-issues are the workstream's phases.

- PRs open as **draft** and stay draft until every phase is verified.
- The agent works through every phase **continuously** — the mechanical verification gates (and the skill-enforcement gates) *are* the gates between phases. No human review between phases; pause only if genuinely stuck or a review gate trips.
- **Issues track work state continuously — not optional.** As each phase completes, close its sub-issue with a comment marking where the work landed (`gh issue close <n> --reason completed --comment "Done in <sha> on PR #<pr> — <area>"`). The Epic auto-checks it off. The PR body and the issues must never lag the real state of the work.
- When all phases are done and all verifications pass → mark the PR **ready for review**, add the `ready-for-review` label, and post a **reviewer's brief** as a comment on **both the Epic and the PR** (same body, deliberately duplicated so a reviewer — or a first-pass AI review bot — finds it on either surface): how to run it (exact commands), what to verify (specific paths/flows and what "correct" looks like), how to review it, and anything fragile that needs extra eyes. The human does the final review and merge — the workflow never merges the PR itself.
- **The PR must be cleanly mergeable before it's marked ready.** A conflicted branch stalls at the human's final merge with all the work already done — confirm `gh pr view <n> --json mergeable` reads `MERGEABLE` before `gh pr ready`. Resolving divergence with `main` is the agent's job, never the merger's.
- **If the PR is rejected:** reopen the closed sub-issues (and the Epic, if it was closed), `gh pr close <n> --delete-branch`, and retry the workstream from scratch.
- **Review feedback: resolve the class, not the instance.** When a review comment reveals a fragile approach (not a one-off), harden that whole approach within the comment's blast radius (the function/section it touches) in one pass — each adjacent fix with its own test, nothing outside that radius. Fixing only the literal line invites the reviewer to find the next adjacent edge one round at a time (and can blow the auto-loop's round cap). **And self-review before pushing — be your own CodeRabbit:** adversarially hunt the adjacent edges in your own diff so the reviewer only surfaces *new* classes, not the next edge of the one you touched. See `implementing-github-issues` → "Addressing review feedback".
- **Updating a PR body:** `gh pr edit --body-file` fails *silently* on a GitHub projects-classic GraphQL bug (`repository.pullRequest.projectCards`). Always PATCH via `gh api`, then verify:
  ```bash
  jq -n --rawfile body /tmp/body.md '{body: $body}' \
    | gh api -X PATCH /repos/thejustinwalsh/middle/pulls/<n> --input -
  gh pr view <n> --json body --jq '.body' | head
  ```
  `gh pr ready` and `gh issue` commands are unaffected — it's specifically `--body`/`--body-file` edits.

## Tech stack & build

- Bun monorepo (Bun ≥ 1.3.12), TypeScript across the board. See the build spec's "Tech stack" and "Repo layout".
- `bun test` runs tests; `bun run typecheck` (`tsc --noEmit`) type-checks.
- The root `tsconfig.json` enables `allowImportingTsExtensions`, and import specifiers include the `.ts` extension. This is intentional — Bun runs `.ts` natively and `tsc` is type-check-only.

## state-issue contract

`packages/state-issue` is the keystone every downstream phase depends on.

- `schemas/state-issue.v1.md` is the **source of truth** for the schema. The parser, renderer, and `validate` conform to it — not the other way around.
- **Byte-identical round-trip is a hard invariant:** `renderStateIssue(parseStateIssue(render(state)))` must equal `render(state)`. Don't break it; the dispatcher relies on it to edit one section without disturbing others.

## Documentation conventions

The doc surface — module front doors, API comments, and per-folder `CLAUDE.md` — follows fixed conventions so humans and agents find the same context in the same place. The `documenting-the-repo` skill is the authoring guide; the rules below are the load-bearing contract a check enforces.

### Module-index frontmatter

Every `src/index.ts(x)` opens with one leading TSDoc block — the module's **front door**. It does double duty: the bespoke discovery frontmatter *and* the `@packageDocumentation` comment TypeDoc consumes. The format (after any shebang line):

```ts
/**
 * @packageDocumentation
 * @module @middle/<package>
 *
 * <1–2 line module purpose>
 *
 * Public surface:
 * - `name` — what it is / does
 *
 * Where things live:
 * - `file.ts` — what's in it
 *
 * Gotchas:
 * - <load-bearing invariant, or "None.">
 *
 * claude-md: <true|false>
 */
```

Required (a check fails otherwise): the leading `/** … */` block, `@packageDocumentation`, `@module <name>`, the three section headers (`Public surface:`, `Where things live:`, `Gotchas:`), and a `claude-md:` flag that is exactly `true` or `false`. The `claude-md` flag is the **single source of truth** for the per-folder-`CLAUDE.md` decision (below) — set it deliberately; never re-derive it per pass.

The check lives in `packages/cli/src/checks/module-index.ts`, runs as a gating `bun test` (`packages/cli/test/module-index.test.ts`), and surfaces as a `docs` warning in `mm doctor`.
