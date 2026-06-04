/**
 * #224 Inspector responsive smoke: at a 360×640 mobile viewport, opening a
 * workflow's Inspector renders it as a bottom-anchored Sheet (not the desktop
 * right drawer).
 *
 * Updated for #234 (operator-console redesign): the runner chip is opened via
 * the `Open inspector for …` aria-labeled button (no more `.epic-agent` class).
 */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 360, height: 640 } });

test("Inspector opens as a bottom Sheet at 360×640", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("OAuth refresh")).toBeVisible();

  await page
    .getByRole("button", { name: /^Open inspector for / })
    .first()
    .click();

  const inspector = page.locator('[data-slot="sheet-content"]');
  await expect(inspector).toBeVisible();
  // Bottom-anchored, full-width on mobile (sheetVariants side="bottom").
  await expect(inspector).toHaveClass(/bottom-0/);
  await expect(inspector).toHaveClass(/inset-x-0/);
});
