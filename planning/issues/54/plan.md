# Issue #54: Dashboard

**Link:** https://github.com/thejustinwalsh/middle/issues/54
**Branch:** middle-issue-54

## Goal
Build the read-only operator surface for middle: an HTTP server + React 19 SPA on `localhost:8822` with the Needs You / Repos / Inspector views, live SSE updates, a settings page, and an optional windowed mode. Phase 9 of the build spec.

## Approach
- The dashboard is a **self-contained package** (`packages/dashboard`) with a `Bun.serve()` server, mirroring the dispatcher's seam-injection style (`ControlPlane`). All live data is read from the shared SQLite db (operational state) plus the parsed GitHub state issue (recommender output); both come in through an injectable `DashboardDeps` seam so every route unit-tests without a daemon, a real db, or GitHub.
- The server exposes a `createDashboardFetch(deps)` request handler and a thin `Bun.serve` wrapper (`server.ts`) — same shape the dispatcher uses, so the handler is testable on an ephemeral port and could later be composed into the daemon process. **Out of scope:** rewiring the dispatcher's existing hook-server to mount these routes (no sub-issue asks for it; the dispatcher already owns its `/control/*` surface).
- React 19 SPA bundled by **Bun's built-in bundler via HTML imports** (`import index from "./index.html"` → `Bun.serve({ routes })`). No webpack/vite.
- SSE channels reuse the dispatcher's `EventHub` (it was built "so the dashboard's per-repo/session views can reuse it").
- The windowed mode lazy-spawns `webview-bun` in a **separate process** — added as an `optionalDependency` and never imported on the default path, so the test gate never loads a native module.

## Phases (one per sub-issue)
1. **#55** — Bun.serve + SPA bundling + JSON API. The `DashboardDeps` seam, the DB-backed default impl, all `/api/*` routes (stubbed/wired), HTML-import SPA bundling. Test: `GET /api/repos` → JSON.
2. **#56** — React app: Needs You, Repos (header + slot pills + NEXT UP + IN FLIGHT), Issue Inspector drawer (per-runner panel with `controlled_by`, Watch/Take control/Release/copy-command). Reads live from the API.
3. **#57** — SSE channels `/events/global`, `/events/repos/:repo`, `/events/sessions/:session`; the SPA subscribes and updates live (rate-limit banner ≤2s). Test: connect to a channel, assert an emitted event is received.
4. **#58** — Settings view: per-repo + global config editor, rate-limit override buttons (`POST /api/rate-limits/:adapter/clear`), auto-dispatch pause/resume toggle. Test: a settings change round-trips through the API.
5. **#59** — `mm start --window` launches `webview-bun` against `localhost:<port>`; default (no flag) runs HTTP-only with no webview loaded; `[dashboard] windowed` also enables it.

## Files likely to change
- `packages/dashboard/src/{server,deps,db-deps,api,sse,config-store,attach,wire}.ts` — server + seams + routes
- `packages/dashboard/src/index.html` + `src/app/**` — the React SPA
- `packages/dashboard/src/window.ts` — the webview-bun launcher (spawned process)
- `packages/dashboard/{package.json,tsconfig.json}` — deps (react already present; add webview-bun optional), DOM lib
- `packages/cli/src/commands/start.ts` — `--window` → spawn the webview launcher (replacing the browser-opener)
- `packages/dashboard/test/**` — api / sse / settings / app tests

## Out of scope
- Merging the dashboard server into the dispatcher daemon's hook-server process (separate concern; no sub-issue).
- Per-issue cost tracking, multi-user, notifications (spec "out of scope for v1").
- A "merge for me" action — the human always merges.

## Open questions
- Context-token usage isn't a first-class db column; the Inspector surfaces what the events/transcript expose, degrading gracefully when absent. (Resolved: surface best-effort, never block the panel.)
