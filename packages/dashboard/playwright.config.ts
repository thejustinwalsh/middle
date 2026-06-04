/**
 * Playwright smoke config (#224). Chromium-only; specs are named `*.pw.ts` so the
 * `bun test` gate's `.test.`/`.spec.` glob never sweeps them (Playwright uses its
 * own runner, not `bun:test`). `webServer` boots the seeded test daemon
 * (`playwright/serve.ts`) before the specs and tears it down after.
 *
 * Run: `bunx playwright test --config packages/dashboard/playwright.config.ts`
 * (browser install: `bunx playwright install chromium` — see `mm doctor`).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 41_999;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// The daemon must run from the repo root so Bun finds the root `bunfig.toml` and
// resolves the Tailwind bundler plugin — from this package dir the plugin isn't
// resolvable and the SPA serves UNSTYLED (the styles are what we're verifying).
// `fileURLToPath(import.meta.url)` (not Bun's `import.meta.dir`) keeps this working
// under Playwright's Node-based config loader.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  testDir: "./playwright",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }],
  webServer: {
    command: "bun packages/dashboard/playwright/serve.ts",
    cwd: REPO_ROOT,
    url: `${BASE_URL}/`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    env: { PW_PORT: String(PORT) },
  },
});
