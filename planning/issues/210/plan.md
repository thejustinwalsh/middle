# Issue #210: feat(dashboard): shadcn/Tailwind product pass

**Link:** https://github.com/thejustinwalsh/middle/issues/210
**Branch:** middle-issue-210

## Goal
Bring the dashboard (`packages/dashboard`) from hand-written CSS + vanilla React to a
shadcn/ui + Tailwind v4 product surface — accessible, responsive, with loading/error
states and Playwright smoke coverage — **without changing the backend JSON/SSE API
contract**.

## Approach
- Tailwind v4 bundles through **Bun's built-in HTML-import bundler** via
  `bun-plugin-tailwind`, registered in a root `bunfig.toml` `[serve.static].plugins`.
  No webpack/vite step — same lazy-bundle-on-first-request model the SPA uses today.
  (De-risked: verified the served `/` CSS contains used utilities end-to-end through
  `createDashboardServer`.)
- shadcn primitives are **vendored as source** into `src/app/components/ui/` (the
  shadcn model is copy-paste source over Radix + `cva`/`clsx`/`tailwind-merge`), since
  the shadcn CLI assumes Vite/Next path-aliases we don't have.
- Existing dark theme (`styles.css` custom props) is mapped into Tailwind `@theme`
  tokens + the shadcn token names so the surface renders identically before primitives
  are swapped, then CSS rules are deleted as each primitive lands.
- jsdom-style component tests use `@happy-dom/global-registrator` (Bun's DOM-in-test
  path) for focus/responsive/error behavior; Playwright (Chromium) covers the 3 e2e
  flows. Playwright specs are named to stay **out of the `bun test` gate's glob**.
- Sync with `main` as we go (`git rerere` on); rebase by default.

## Phases (one per open sub-issue)
1. **#219 scaffold** — Tailwind v4 + `bun-plugin-tailwind` + bunfig; `cn()` util; map
   tokens; vendor the empty shadcn primitive shells. No visual change; SPA renders
   identically; integration smoke asserts the served SPA shell + tokens load.
2. **#220 primitives** — replace hand-rolled Tabs/Button/Select/Input/Sheet/Badge/
   Progress/Collapsible with shadcn equivalents across the SPA; delete the matching CSS;
   keep handlers/payloads identical. Integration: assert `data-radix-*`/shadcn markup.
3. **#221 focus/hover/keyboard** — `:focus-visible` ring on every focusable, hover on
   every Button, `aria-label` on the `●/○` status glyphs, logical Tab order. Integration:
   happy-dom keyboard test asserts the focus ring class on each Tab stop.
4. **#222 responsive** — Inspector → right Sheet ≥1024px / bottom Sheet <768px; repo
   expansions stack <768px; nav → Sheet menu <640px; no px widths in JSX. Integration:
   happy-dom viewport test asserts bottom-anchored Sheet at 360×640.
5. **#223 loading/error** — Skeletons for repo expansions / Queue tiles / Activity;
   inline per-view error panel with a working Retry; >10s timeout → distinct
   "Connection lost — retrying…". Integration: mocked-throw fetch → error panel →
   retry → data.
6. **#224 Playwright smoke** — `@playwright/test` + `playwright.config.ts`; 3 specs
   (Epics, Queue, Inspector-responsive) against a real served test daemon; documented in
   `mm doctor`; wired so the suite is runnable without breaking the `bun test` gate.

## Files likely to change
- `package.json` / `bun.lock` — tailwind, plugin, Radix primitives, happy-dom, playwright (done for tailwind)
- `bunfig.toml` (new, root) — `[serve.static].plugins`; `[test].preload` for happy-dom
- `packages/dashboard/src/app/styles.css` → `tailwind.css` + `@theme` tokens (shrinks as CSS is deleted)
- `packages/dashboard/src/app/components/ui/*` (new) — vendored shadcn primitives + `lib/cn.ts`
- `packages/dashboard/src/app/components/*.tsx` — refactored to use the primitives + a11y/responsive/loading
- `packages/dashboard/test/*` — updated render assertions + new `focus-visible` / `responsive` / `error-recovery` tests
- `packages/dashboard/playwright/*` (new) — Playwright config + specs
- `packages/dashboard/CLAUDE.md` (new) — local invariants (Tailwind-via-bunfig, Playwright-outside-bun-test); flip the `claude-md` flag in the same change
- `packages/cli/src/checks/doctor` — document `bunx playwright install chromium`

## Out of scope
- Backend API/SSE contract changes (hard constraint — no `wire.ts` shape changes)
- Virtual scrolling for 1000+ rows (explicitly out per #223)
- Visual-regression (Percy/Chromatic), cross-browser matrix, full axe audit
- Light-mode theme (dark-only stays; tokens are structured to allow it later)

## Open questions
- None blocking. "CI on every commit" (#224) maps to this repo's `.middle/verify.toml`
  gate system — there is no GitHub Actions workflow — so the Playwright suite is made
  runnable + documented, and deliberately kept out of the `bun test` gate (Chromium isn't
  guaranteed in the dispatch env). Noted here rather than blocking.
