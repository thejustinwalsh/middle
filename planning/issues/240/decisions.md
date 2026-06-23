# Decisions — Issue #240

## Change `dispatchEpic` to accept a string epicRef instead of a numeric epicNumber
**File(s):** `packages/dashboard/src/deps.ts`, `packages/dashboard/src/api.ts`
**Date:** 2026-06-23

**Decision:** Change the `dispatchEpic` seam signature from `(repo, epicNumber: number, adapter)` to
`(repo, epicRef: string, adapter)`. The route passes the raw `:n` path segment as-is (a slug or
an integer string), and the production wiring passes it as `epicRef` to `/control/dispatch` which
already accepts either form.

**Why:** The control plane (`hook-server.ts` `#handleControlDispatch`) already handles both
`epicRef` (non-empty string) and `epicNumber` (integer ≥ 1) in the request body — and normalizes
them to a single `epicRef` string before calling `startDispatch`. So no new protocol is needed;
the route just needs to stop requiring an integer in the URL segment and instead pass the segment
value through as a string.

**Why not a separate `/api/epics/:repo/:slug/dispatch` route?** A single unified route is
simpler. The segment is already a string that could be "7" (numeric) or "rollout-epic-store"
(slug) — the current code just asserts it must look like an integer. Removing that assertion
while keeping the same route shape avoids a breaking change to numeric dispatch callers.

**Evidence:** `hook-server.ts` L425-430 already handles `epicRef` as a string. `auto-dispatch.ts`
`parseEpicRef` extracts `\S+` from `#<ref> <title>` — already slug-aware.

## The SPA dispatch button gate removal
**File(s):** `packages/dashboard/src/app/components/Epics.tsx`
**Date:** 2026-06-23

**Decision:** Remove the `isFileEpic` gate that disabled the dispatch button for file-mode Epics,
and update the `onDispatch` callback to pass a string `epicRef` instead of a numeric `epicNumber`.

**Why:** The original gate comment says "no numeric handle for the dashboard's numeric dispatch
route". Once the route accepts slugs, this restriction is lifted. The callback now passes
`card.ref` (which is either a slug or the string form of the GitHub issue number) rather than
the nullable `card.number`.

**Tradeoff:** The `onDispatch` prop changes from `(repo: string, epicNumber: number, adapter: string)`
to `(repo: string, epicRef: string, adapter: string)`. This is a type-level breaking change for
any callers that hard-code the numeric type. In the codebase there is exactly one call site (App.tsx)
and one test (the SSR Epics test). Both are updated in this PR.
