# `@middle/dashboard` — local conventions

Local, non-obvious facts for working on the dashboard SPA. Root `CLAUDE.md` wins on
any conflict; this only covers what isn't derivable from the code.

## Styling: Tailwind v4 + shadcn, no build step

- Tailwind v4 compiles through **Bun's built-in HTML-import bundler** via
  `bun-plugin-tailwind`, registered in the **root** `bunfig.toml`
  (`[serve.static].plugins`). There is no Vite/webpack/Tailwind-CLI step — the SPA
  is bundled lazily on first request (`server.ts`), and the same path runs under
  `bun test` (`spa.test.ts`/`scaffold.test.ts`).
- Because the plugin is resolved relative to `bunfig.toml`, the toolchain deps
  (`tailwindcss`, `bun-plugin-tailwind`) live in the **root** `package.json`
  devDependencies, **not** this package's. The Radix/cva/clsx/tailwind-merge deps
  (imported by app code) live here.
- `app/tailwind.css` imports `theme` + `utilities` **without preflight**, plus a
  minimal `@layer base` reset (`box-sizing` + a `border-width:0; border-style:solid;
  border-color` so shadcn borders render). Preflight is omitted deliberately so the
  legacy `styles.css` (unlayered, shrinking) keeps the surface stable; don't add
  the umbrella `@import "tailwindcss"` without re-checking the legacy views.
- shadcn primitives are **vendored as source** in `app/components/ui/` (modern
  function-component style with `data-slot`), over Radix. There is no shadcn CLI /
  `components.json` here; add a primitive by copying its source and fixing imports
  to relative `.ts`/`.tsx`. `app/lib/utils.ts` exports `cn`.
- The shadcn semantic tokens (`--color-*`) are `@theme inline` aliases of the
  legacy GitHub-dark palette (`--bg`/`--fg`/`--accent`/…) — one palette source.

## Tests: SSR vs DOM, and Playwright

- Most component tests render with `renderToStaticMarkup` (SSR to a string) and
  assert text / `data-slot`. The live-server tests boot a real `Bun.serve` and use
  native `fetch`.
- DOM/interaction tests (Radix portals, focus, responsive, error-recovery) use
  happy-dom via `test/dom.tsx`. **happy-dom is registered ONCE per process** (the
  registrator isn't safe to register/unregister-cycle); `dom.tsx` restores the
  native web primitives so the live-server tests are unaffected. DOM test files
  must import their components **dynamically inside `beforeAll`** (after
  `registerDom()`) — a Radix primitive imported earlier won't mount its portal.
  When asserting `document.activeElement`, compare as a boolean (`=== el`), never
  `toBe(el)` (it serializes the whole DOM node on a mismatch — a multi-second hang).
- Playwright smoke specs are `playwright/*.pw.ts` — named `.pw.ts` so the `bun test`
  gate's `.test.`/`.spec.` glob never sweeps them (they use Playwright's runner, not
  `bun:test`). Run them with `bunx playwright test` **from this package dir** (so the
  local `@playwright/test` is used, not a bunx-fetched copy). `playwright/serve.ts`
  is the seeded test daemon (dashboard routes + stubbed `/control/*`). Browser
  install: `bunx playwright install chromium` (`mm doctor` reports it). CI runs them
  as a separate job (`.github/workflows/e2e.yml`), not part of `bun test`.
