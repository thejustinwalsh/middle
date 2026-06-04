/**
 * #224 Queue smoke: navigate to the Queue tab and assert the gauge tiles render
 * and the in-flight table shows the waiting-human row (from the `/control/events`
 * frame) with its state badge.
 */
import { expect, test } from "@playwright/test";

test("Queue: the in-flight table shows a waiting-human row with its state badge", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "queue" }).click();

  // Gauge tiles.
  await expect(page.getByText("Waiting for you")).toBeVisible();

  // The waiting-human frame surfaces as a state Badge in the in-flight table.
  const badge = page.locator('[data-slot="badge"]', { hasText: "waiting-human" });
  await expect(badge).toBeVisible();
});
