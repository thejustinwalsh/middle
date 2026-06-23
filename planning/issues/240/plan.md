# Issue #240: feat(dispatcher): slug-aware force-dispatch route for file-mode Epics

**Link:** https://github.com/thejustinwalsh/middle/issues/240
**Branch:** feat/slug-force-dispatch

## Goal

Close the parity gap: the dashboard force-dispatch route should accept a slug (file-mode Epic
identifier) in addition to a numeric Epic ID, reusing the existing slug-resolution logic so
`mm dispatch <slug>` and the dashboard dispatch button resolve to the same Epic.

## Approach

- The `:n` path segment in `POST /api/epics/:repo/:n/dispatch` currently requires an integer.
  Relax it to accept any non-empty string (slug or integer string); let the downstream
  `dispatchEpic` seam decide what to do with it.
- Change the `dispatchEpic` seam in `deps.ts` from `(repo, epicNumber: number, adapter)` to
  `(repo, epicRef: string, adapter)` — the route passes the raw `:n` segment as a string, and
  the control-client that wires this in production passes it as `epicRef` to `/control/dispatch`
  (which already accepts either `epicRef` or `epicNumber`).
- Update `control-client.ts` (the production wiring) to pass `epicRef` to `/control/dispatch`.
- Update the SPA: `api-client.ts` dispatch call, `App.tsx` callback, and `Epics.tsx` component.
  Remove the `isFileEpic` gate that was blocking the dispatch button for file-mode Epics.
- TDD: write failing tests in `packages/dispatcher/test/` and `packages/dashboard/test/` first.

## Phases

1. Tests (failing) — route accepts slug, returns "Epic not found" for unknown slug, round-trip
   parity between CLI and dashboard dispatch
2. Implementation — route, deps seam, control-client, SPA
3. Verification — `bun test`, typecheck, lint

## Files likely to change

- `packages/dashboard/src/api.ts` — relax `:n` to accept any non-empty string
- `packages/dashboard/src/deps.ts` — `dispatchEpic` signature: `number → string`
- `packages/dashboard/src/db-deps.ts` — update `dispatch` seam type
- `packages/dashboard/src/app/api-client.ts` — dispatch call uses `epicRef: string`
- `packages/dashboard/src/app/App.tsx` — callback passes `epicRef` (slug or number as string)
- `packages/dashboard/src/app/components/Epics.tsx` — remove `isFileEpic` gate, enable dispatch
- `packages/dashboard/test/epics-api.test.ts` — add slug dispatch tests
- `packages/dispatcher/test/epic-store/` — add a slug-dispatch round-trip integration test

## Out of scope

- Changing the SPA's `onDispatch(repo, epicNumber, adapter)` signature to `(repo, epicRef, adapter)`
  in the Playwright smoke tests (those test the full UI — but can be patched as-needed)
- The file-watcher/resume path — that's separate

## Open questions

- None: the control-plane already accepts `epicRef` as a string slug, so no new protocol is needed.
