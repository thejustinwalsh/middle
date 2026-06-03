# Epic #190: feat(epic-store): file-backed Epic store (opt-in hybrid)

**Link:** https://github.com/thejustinwalsh/middle/issues/190
**Branch:** middle-issue-190

## Goal
Ship an opt-in, per-repo **file-backed Epic store** as a peer to today's GitHub-backed
mode. One Markdown file per Epic under `planning/epics/`, recommender state in
`.middle/state.md`; PRs/reviews/CI stay GitHub-native in both modes ("hybrid").
Workflow bodies, gates, watchdog, hook server, and poller stay **unchanged** — the
three DI'd gateway interfaces (`EpicGateway`, `StateGateway`, `PollGateway`) gain
parallel file implementations selected per-repo at bootstrap.

## Approach
- The foundation (gateway rename, migrations 007/008/009, Epic-file parser/renderer +
  byte-identical round-trip) merged in PR #188 and is already on this branch's base.
- Make the workflow seam string-keyed (`epicRef: string`) so a file slug is a
  first-class Epic identifier; github mode parses `Number(epicRef)` at the `gh` boundary.
- Add three composite file gateways: Epic/state methods read/write local files via the
  existing pure parser+renderer; PR-shaped methods delegate to an injected `gh` backend.
- Select the gateway trio per-repo from `repo_config.epic_store` in `build-deps.ts`.
  The agent's `blocked.json` flow plugs in unchanged at the `postQuestion` DI seam.
- Surface it through `mm` (init/dispatch/doctor/resume), abstract the Epic-aware skills
  mode-agnostically, and prove "no workflow code changes" with a parametrized parity test.
- Phase 2 adds the mtime-poll file-watcher Q&A loop on the existing 120s poller cron.

## Phases (= open sub-issues, in dependency order)
1. **#191** refactor(dispatcher): `EpicGateway` takes `epicRef: string` everywhere
2. **#192** feat(epic-store): file-backed gateway implementations (Epic, State, Poll) — *blocked by #191*
3. **#193** feat(epic-store): bootstrap selector + `postQuestion` file-mode wiring — *blocked by #192*
4. **#194** feat(cli): `mm init/dispatch/doctor/resume` — file-mode support — *blocked by #193*
5. **#195** refactor(skills): abstract Epic-aware skills + dispatch-brief mode injection — *blocked by #193*
6. **#196** test(epic-store): parity test (github ⇔ file) + Phase 1 smoke — *blocked by #194, #195*
7. **#197** feat(epic-store): Phase 2 — file-watcher Q&A loop on the poller cron — *blocked by #196*

## Files likely to change
- `packages/dispatcher/src/github.ts`, `state-issue.ts`, `poller.ts`, `poller-gateway.ts` — `epicRef: string` on the interfaces; `ghGitHub` parses to number at the boundary (#191)
- `packages/dispatcher/src/workflows/{implementation,recommender,documentation}.ts`, `main.ts`, `build-deps.ts`, `auto-dispatch.ts`, `hook-server.ts`, `workflow-record.ts`, `gates/*`, `reconcilers/*`, `recovery.ts` — `epicNumber` → `epicRef` threading + `epic_ref` column reads/writes (#191)
- `packages/dispatcher/src/epic-store/{index.ts,file-epic-gateway.ts,file-state-gateway.ts,file-poll-gateway.ts,watcher.ts}` — new (#192, #193, #197)
- `packages/dispatcher/src/build-deps.ts` — `buildGitHubGateways`/`buildFileGateways` switch (#193)
- `packages/cli/src/commands/{init,dispatch,doctor,resume}.ts` — file-mode CLI (#194)
- `packages/skills/{implementing,recommending,creating}-github-issues/` — abstract bodies + `references/<mode>-mode-commands.md` (#195)
- `packages/dispatcher/test/epic-store/*` — gateway unit tests + `parity.test.ts` (#192, #196)

## Out of scope
- File-backed PRs/reviews/CI (GitHub-native in both modes)
- GitHub→file migration (`mm migrate-to-file`)
- Real-time `chokidar`/`fs.watch` (Phase 2 uses mtime polling on the 120s cron)
- An abstract `EpicStore` interface above the gateways (Approach B; only if a 3rd backend appears)
- Cross-repo Epic references

## Open questions
- None blocking. The "Open design fork" from PR #188 (epicRef refactor — option A full
  refactor) is already resolved in favor of A per #191's body.
