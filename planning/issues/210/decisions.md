# Decisions — Issue #210 (dashboard shadcn/Tailwind pass)

## Tailwind v4 bundles through Bun's HTML importer, not a Vite/webpack step
**File(s):** `bunfig.toml`, `packages/dashboard/src/app/tailwind.css`
**Date:** 2026-06-04

**Decision:** Register `bun-plugin-tailwind` in the root `bunfig.toml`
`[serve.static].plugins`. The dashboard SPA is already bundled by Bun's built-in
HTML-import bundler (`createDashboardServer` → `import("./index.html")`), and that
same path runs under `bun test` — so Tailwind compiles with zero new build tooling.
**Why:** The package's whole serving model is "lazy-bundle the HTML on first request,
no webpack/vite" (`server.ts`). A separate Tailwind CLI build step would break that and
the `spa.test.ts` model. The plugin is the Bun-native way to get Tailwind v4 into that
pipeline.
**Evidence:** Probed end-to-end before committing — booted `createDashboardServer`,
fetched `/`, followed the bundled `.css` link, and confirmed used utilities (`ring-2`)
appear in the served CSS. The plugin resolves relative to `bunfig.toml`, so the
toolchain deps (`tailwindcss`, `bun-plugin-tailwind`) live in ROOT devDependencies, not
the dashboard package (Bun doesn't hoist them — native binaries keep them package-local).

## Phase 1 imports Tailwind without preflight (theme + utilities only)
**File(s):** `packages/dashboard/src/app/tailwind.css`
**Date:** 2026-06-04

**Decision:** Import `tailwindcss/theme.css` + `tailwindcss/utilities.css` as explicit
layers instead of the umbrella `@import "tailwindcss"` (which also pulls preflight, the
`base` layer).
**Why:** #219's hard constraint is "every existing view renders pixel-identically".
Preflight resets unstyled elements (e.g. the Settings `save`/`pause` buttons rely on
browser-default button styling today); pulling it in would visibly change them. The
legacy `styles.css` keeps its own minimal reset and is unlayered, so it still wins over
utilities until each rule is deleted as its component moves to a shadcn primitive.
**Evidence:** Probe confirmed the granular import emits utilities + `@apply` works and
does NOT emit the button/input reset block.

## shadcn primitives are vendored as source, not installed via the CLI
**File(s):** `packages/dashboard/src/app/components/ui/*`, `.../lib/utils.ts`
**Date:** 2026-06-04

**Decision:** Hand-vendor the shadcn component source (modern function-component style
with `data-slot` attributes, no `forwardRef`) over Radix + `cva`/`clsx`/`tailwind-merge`,
adapted to relative `.ts`/`.tsx` imports.
**Why:** The shadcn CLI assumes Vite/Next path aliases (`@/components`, `@/lib/utils`) and
a `components.json` we don't have; vendoring the source IS the shadcn distribution model,
so this is the same artifact without fighting the toolchain. The modern data-slot style
works cleanly with React 19 (ref is a normal prop) and gives the integration tests a
stable `data-slot="…"` hook to assert the primitive rendered.
**Evidence:** shadcn/ui registry source; the repo's `allowImportingTsExtensions` makes the
relative `.ts` imports first-class.

## shadcn semantic tokens alias the existing GitHub-dark palette
**File(s):** `packages/dashboard/src/app/tailwind.css`
**Date:** 2026-06-04

**Decision:** `@theme inline` maps `--color-background/foreground/primary/...` onto the
legacy palette vars (`--bg`, `--fg`, `--accent`, `--muted`, `--bad`, ...) that
`styles.css` already defines, rather than introducing a second palette.
**Why:** Single source of truth for the colors — the dark theme renders identically, and a
future light theme only has to override the legacy vars. Avoids the name collision where
shadcn's `--accent`/`--muted` (subtle backgrounds) mean something different from the
legacy `--accent` (blue primary) / `--muted` (gray text): legacy `--accent` → shadcn
`--color-primary`/`--color-ring`; legacy `--muted` → shadcn `--color-muted-foreground`.

## Inspector becomes a Radix Dialog Sheet → DOM tests via happy-dom
**File(s):** `packages/dashboard/src/app/components/Inspector.tsx`, `test/dom.tsx`, `test/inspector.test.tsx`
**Date:** 2026-06-04

**Decision:** The Inspector is now a shadcn `Sheet` (Radix Dialog), controlled `open`
(App only mounts it when a session is selected; Escape/overlay/X route through
`onOpenChange → onClose`). Its portaled content can't be captured by
`renderToStaticMarkup`, so the Inspector tests moved to a real DOM (happy-dom) in
`inspector.test.tsx`.
**Why:** #220 wants the Inspector to "open as a Sheet (not a fixed-position div)".
Radix portals only mount into a live `document.body`. happy-dom is registered PER FILE
(not globally) because its `fetch` replacement can't reach a live `Bun.serve` — the
live-server tests stay happy-dom-free. And DOM test files must import their components
*dynamically after* `registerDom()`: a Radix Dialog imported before happy-dom registers
binds to a doc-less global and never mounts its portal (verified the failure + the fix).
**Evidence:** `test/dom.tsx` header documents the constraints; `inspector.test.tsx`
asserts `data-slot="sheet-content"` + `role="dialog"` and the panel content.

## No-preflight needs an explicit border reset; state-color CSS → Badge variants
**File(s):** `packages/dashboard/src/app/tailwind.css`, `styles.css`, `components/Queue.tsx`, `Activity.tsx`
**Date:** 2026-06-04

**Decision:** Add a minimal `@layer base` reset (`border-width:0; border-style:solid;
border-color:var(--border)`) — the slice of preflight the shadcn borders need — without
the rest of preflight. The queue state colors (`.s-*`) and rate-limit chips (`.c-*`) and
the activity run-state tones become Badge `variant`s; their `s-<state>`/`c-<status>`/
`run-state <tone>` class names are kept purely as test/data hooks (their CSS is deleted).
**Why:** Tailwind v4's `border` utility only sets a width and relies on preflight for
`border-style: solid`; without it shadcn's Sheet/Select/Input/Badge borders render
invisible. Keeping the legacy class names as hooks let the existing queue/activity tests
keep asserting state without coupling to the deleted color rules — the color now comes
from the Badge variant.
**Evidence:** Served-CSS probe confirms `bg-primary`/`border-input`/`ring-ring`/`bg-card`/
`animate-pulse` compile and `border-style: solid` is in the base layer.

## Focus-visible rides on the shadcn primitives; anchors get a base fallback
**File(s):** `tailwind.css`, `components/Inspector.tsx`, `test/focus-visible.test.tsx`
**Date:** 2026-06-04

**Decision:** The shadcn primitives already carry `focus-visible:ring-2 ring-ring
ring-offset-2` from #220, so #221 is mostly additive: a base-layer `:focus-visible`
outline for plain anchors / `[tabindex]` (not covered by a primitive), and an
`aria-label` ("session alive"/"session ended") on the Inspector liveness Badge with the
`●/○` glyph marked `aria-hidden` so screenreaders announce the semantic, not "black
circle". (Queue uses text state labels, not a glyph — already screenreader-friendly.)
**Why:** Keeps the focus styling DRY (one ring convention, defined where the primitive
lives) and the a11y fix localized.
**Evidence:** `focus-visible.test.tsx` (happy-dom) focuses each tab-reachable element on
the Epics view and asserts it becomes `activeElement`, plus that the primitives carry the
`focus-visible:ring` class. happy-dom can't move focus on a synthetic Tab, so real Tab
traversal + the painted ring go to the Playwright smoke (#224). NB: assert
`activeElement === el` as a BOOLEAN — `toBe(el)` serializes the whole happy-dom node on a
mismatch (a 279s hang).

## Responsive: JS-driven Inspector side, CSS-driven nav/stacking
**File(s):** `useMediaQuery.ts`, `components/Inspector.tsx`, `App.tsx`, `Repos.tsx`, `test/responsive.test.tsx`
**Date:** 2026-06-04

**Decision:** The Inspector Sheet's anchor edge branches in JS via a `useMediaQuery`
hook (`right` ≥1024px, `bottom` <1024 — so <768 is covered). The nav collapse
(`hidden sm:block` Tabs + a `sm:hidden` hamburger that opens a left Sheet menu) and the
repo-expansion stacking (`flex flex-col md:flex-row`) are pure CSS responsive utilities —
no px widths in JSX.
**Why:** The anchor edge changes a *prop* (`side`), which CSS can't do — it needs JS. The
nav/stacking are presentation-only, so Tailwind breakpoints keep them declarative and
out of the render logic. The `<768` and `≥1024` bounds are explicit in the AC; the
768–1024 band falls to `bottom` (the simplest split that honors both bounds).
**Evidence:** `responsive.test.tsx` mocks `matchMedia` at 360px → asserts the Inspector's
SheetContent carries the bottom-anchor classes (`bottom-0 inset-x-0`, not `inset-y-0`),
and at 1280px → the right-anchor classes. The CSS-only bits are verified visually in #224.

## #223 loading/error via a useAsyncResource hook; happy-dom registered once
**File(s):** `useAsyncResource.ts`, `components/{RepoExpansion,InlineError}.tsx`, `App.tsx`, `test/dom.tsx`
**Date:** 2026-06-04

**Decision:** A `useAsyncResource(loader, {timeoutMs, deps})` hook drives loading /
success / error / timeout + `reload`. The repo expansion is now self-fetching
(`RepoExpansion`): App supplies `loadDetail` + bumps a per-repo `reloadSignal` on poll
tick / SSE event (replacing the old `details` map + `refreshDetail`). The expansion
renders a Skeleton → content → `InlineError` (Retry) / "Connection lost — retrying…".
Queue/Activity show skeletons + an inline `InlineError` keyed off the existing guard's
`source` (so the global bar is suppressed for those views).
**Why (timeout):** the timeout transition fires from the hook's OWN timer, not by
waiting for the loader to reject on abort — `api.repo` ignores the signal, so an
abort-only design would hang in "loading" forever past 10s (caught by the timeout test).
The timer is cancelled on unmount/reload (a leaked timer firing `setState` post-unmount
both warns and, under happy-dom, corrupts the DOM).
**Why (happy-dom once):** `@happy-dom/global-registrator` is not safe to
register/unregister-cycle — across 5 DOM test files it threw `removeChild` DOMExceptions
on unmount and degraded its timers (both flaky only in the full suite). Registering ONCE
and restoring the native web primitives the live-server tests need (`fetch`/`Response`/
streams/timers) is stable: 117 dashboard tests green ×3 runs, full monorepo 1382 green.
