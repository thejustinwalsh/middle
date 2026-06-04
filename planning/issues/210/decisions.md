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
