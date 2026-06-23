# Decisions — Issue #242

## Reason token format: hyphen-separated kebab-case

**File(s):** `packages/dispatcher/src/workflows/recommender.ts`, `implementation.ts`
**Date:** 2026-06-23

**Decision:** Use `"session-ended-before-Stop"` and `"Stop-hook-timed-out"` as the
canonical reason tokens (matching the issue title).

**Why:** The issue body and the PR #233 description both name these exact strings.
Using them verbatim avoids confusion between the issue's description and the
implementation. They are machine-readable (no spaces) but human-parseable, and the
`endReasonMeta()` function in Activity.tsx maps them to full human labels for the UI.

## `title` attribute for tooltips (not a Radix Tooltip component)

**File(s):** `packages/dashboard/src/app/components/Activity.tsx`
**Date:** 2026-06-23

**Decision:** Use the native HTML `title` attribute on the `Badge` for the tooltip,
not a vendored Radix/shadcn Tooltip primitive.

**Why:** No Tooltip component is vendored in `app/components/ui/` (the dashboard
CLAUDE.md says "check if there's a Radix/shadcn primitive already vendored" — there
isn't). Adding a new Radix primitive just for this feature would be out-of-scope
scope creep. The `title` attribute renders in SSR (works in `renderToStaticMarkup`
tests), is accessible, and is the standard lightweight approach for simple tooltips.
The issue acceptance criteria only requires "a tooltip" — it doesn't specify an
interactive Radix tooltip.

## `end_reason` as a dedicated column (not in `meta_json`)

**File(s):** `packages/dispatcher/src/db/migrations/012_workflows_end_reason.sql`
**Date:** 2026-06-23

**Decision:** Add a proper `end_reason TEXT` column to `workflows` via a migration,
rather than storing the reason in `meta_json`.

**Why:** `meta_json` is explicitly documented as "scratch" (not activity signal, not
bumped for `updated_at`). The end-reason needs to be queryable and projectable by the
dashboard's read path without parsing JSON blobs. A dedicated column also makes a
future filter/index possible.

## `workflowId` threaded as optional arg (not a closure)

**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-06-23

**Decision:** Pass `workflowId?: string` explicitly down through `awaitNextStop` /
`resolveBareStop` / `enforceVerifyOnDone` rather than closing over `ctx`.

**Why:** `awaitNextStop` is an inner function defined before the per-drive `ctx` is
in scope. It already takes all its args explicitly (tag, sessionName, worktree,
timeoutMs, classifyAt). Adding `workflowId` as an optional arg keeps the pattern
consistent, avoids a confusing closure over a mutable `ctx`, and makes the
write-before-throw conditional: a test that doesn't pass `workflowId` never touches
the DB (no regression). The recommender's case is simpler — `ctx` is directly in
scope — so it writes inline without an arg.
