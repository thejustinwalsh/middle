/**
 * #224 Queue smoke: navigate to the Queue view via the sidebar nav and assert
 * the gauge tiles render and the in-flight table shows the waiting-human row
 * (from the `/control/events` frame) with its state badge.
 *
 * Updated for #234 (operator-console redesign): the shadcn `Tabs` strip is
 * replaced by the Sidebar — every view button carries `data-view="<view>"`.
 * At narrow widths the same buttons mount inside a Sheet behind the hamburger
 * trigger; `.first()` covers either layout without forcing a viewport.
 */
import { expect, test } from "@playwright/test";

test("Queue: the in-flight table shows a waiting-human row with its state badge", async ({
  page,
}) => {
  await page.goto("/");
  // The sidebar nav entry — stable test seam via `data-view`.
  await page.locator('button[data-view="queue"]').first().click();

  // Gauge tiles.
  await expect(page.getByText("Waiting for you")).toBeVisible();

  // The waiting-human frame surfaces as a state Badge in the in-flight table.
  const badge = page.locator('[data-slot="badge"]', { hasText: "waiting-human" });
  await expect(badge).toBeVisible();
});
