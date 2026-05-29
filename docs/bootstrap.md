# Bootstrap

`mm init <repo-path>` stamps middle into a target repo: the skills a dispatched agent runs, the hook config that reports its activity, the per-repo config, and the dispatch state issue. This is a reference for what gets written and where. `mm uninit` reverses it.

## What `mm init` writes

`mm init` takes a path to a local checkout. Run it with `--dry-run` first to print the planned actions without touching anything.

```bash
mm init <repo-path> --dry-run   # print the plan
mm init <repo-path>             # apply it
```

Before writing, `mm init` validates the target: it must be a git repo with a clean worktree and an `origin` remote, and `gh` must be authenticated.

It then performs these actions:

1. **Stage skills** into `.claude/skills/` and `.codex/skills/` — copied from middle's canonical `packages/skills/`. These are the skills a dispatched agent invokes (`implementing-github-issues`, `recommending-github-issues`, `creating-github-issues`, `documenting-the-repo`).
2. **Stage the hook script** to `.middle/hooks/hook.sh` — the universal POST script that reports agent activity to the dispatcher.
3. **Write hook config** — `.claude/settings.json` (Claude Code hook entries) and a sentinel-delimited block appended to `.codex/config.toml`.
4. **Resolve the state issue** — trust the number in an existing local config, otherwise find or create the dispatch state issue on GitHub and label it.
5. **Write `.middle/config.toml`** — the per-repo config, merged from global defaults plus the resolved state-issue number and bootstrap version.
6. **Add `.middle/` to `.gitignore`** — middle's operational directory is local, never committed.

## What lands in the target repo

| Path | Purpose | Committed? |
|---|---|---|
| `.middle/config.toml` | Per-repo config (limits, recommender, state-issue number) | No (`.gitignore`) |
| `.middle/hooks/hook.sh` | Universal hook POST script | No |
| `.claude/settings.json` | Claude Code hook entries | Per the repo's own policy |
| `.claude/skills/` | Stamped skill copies | Per the repo's own policy |
| `.codex/config.toml` | Codex hook block (sentinel-delimited) | Per the repo's own policy |
| `.codex/skills/` | Stamped skill copies | Per the repo's own policy |

`.middle/prompt.md` — the dispatch brief — is written per dispatch by the workflow, not by `mm init`.

## The hook script

`.middle/hooks/hook.sh` is a small POSIX script that POSTs each hook payload to the dispatcher and never blocks the agent:

```sh
#!/bin/sh
EVENT="$1"
curl -sS -X POST "${MIDDLE_DISPATCHER_URL}/hooks/${EVENT}" \
  -H "X-Middle-Session: ${MIDDLE_SESSION}" \
  -H "X-Middle-Token: ${MIDDLE_SESSION_TOKEN}" \
  -H "X-Middle-Epic: ${MIDDLE_EPIC}" \
  -H "Content-Type: application/json" \
  --data-binary @- --max-time 3 || true
exit 0
```

It reads the hook payload on stdin, posts it to `${MIDDLE_DISPATCHER_URL}/hooks/<event>`, and exits 0 regardless — a dispatcher that is slow or down (the `--max-time 3` cap, the `|| true`) never stalls the agent. The session token authenticates the post.

## The two-copy skills invariant

Skill text exists in two places:

- `packages/skills/<skill>/` — the **canonical** source.
- `packages/cli/src/bootstrap-assets/skills/<skill>/` — the **mirror** `mm init` stamps from.

The two must stay byte-identical. `bun run sync-skills` regenerates the mirror; a pre-commit hook (`scripts/hooks/pre-commit`) runs `sync-skills --check` and fails the commit on drift. `mm doctor` surfaces the same drift as a `skills` warning. Edit the canonical copy, then re-sync — never edit the mirror directly.

## Removing middle

`mm uninit <repo-path>` reverses `mm init`: it strips middle's hook entries from `.claude/settings.json` (preserving any other hooks), removes the sentinel-delimited block from `.codex/config.toml`, deletes the `.middle/` directory, and removes the `.gitignore` entry.

```bash
mm uninit <repo-path> --dry-run   # print the plan
mm uninit <repo-path>             # apply it
```
