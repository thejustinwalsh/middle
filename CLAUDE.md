# middle — contributor & agent guide

`middle` autonomously dispatches coding agents against GitHub issues. The authoritative design lives in `planning/middle-management-build-spec.md` — read it for the architecture, build sequence, adapter interface, and state-issue schema. This file is the working-convention summary every contributor and every dispatched agent must follow.

## Git commits

- **Never** add a `Co-Authored-By` trailer for Claude / the assistant / any AI, and no "Generated with …" lines. Plain commit messages only.
- Commit messages and PR titles follow **Conventional Commits**: `feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`, `test(scope): …`.
- Use the repository's configured git identity. Don't pass `-c user.name=…` / `-c user.email=…` overrides.
- We rebase, we don't squash — keep history atomic and meaningful.

## Issue & PR workflow

middle's dispatch unit is an **Epic** — one Epic = one branch = one PR. The Epic's open sub-issues are the workstream's phases.

- PRs open as **draft** and stay draft until every phase is verified.
- The agent works through every phase **continuously** — the mechanical verification gates (and the skill-enforcement gates) *are* the gates between phases. No human review between phases; pause only if genuinely stuck or a review gate trips.
- **Issues track work state continuously — not optional.** As each phase completes, close its sub-issue with a comment marking where the work landed (`gh issue close <n> --reason completed --comment "Done in <sha> on PR #<pr> — <area>"`). The Epic auto-checks it off. The PR body and the issues must never lag the real state of the work.
- When all phases are done and all verifications pass → mark the PR **ready for review**, add the `ready-for-review` label, and comment on the Epic with a **reviewer's brief**: how to run it (exact commands), what to verify (specific paths/flows and what "correct" looks like), how to review it, and anything fragile that needs extra eyes. The human does the final review and merge — the workflow never merges the PR itself.
- **If the PR is rejected:** reopen the closed sub-issues (and the Epic, if it was closed), `gh pr close <n> --delete-branch`, and retry the workstream from scratch.
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
