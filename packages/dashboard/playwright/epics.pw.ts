/**
 * #224 Epics smoke: load `/`, the default Epics view shows the seeded Epic, and
 * clicking its runner opens the Inspector Sheet with the runner panel + timeline.
 */
import { expect, test } from "@playwright/test";

test("Epics: clicking an Epic's runner opens the Inspector with panel + timeline", async ({
  page,
}) => {
  await page.goto("/");

  // Epics is the default view; the seeded Epic card renders.
  await expect(page.getByText("OAuth refresh")).toBeVisible();

  // Tailwind actually compiled + applied (not just present in the DOM): the nav
  // TabsList carries a real `bg-muted` background, not the unstyled transparent
  // default. Guards against the toolchain serving the SPA without its styles.
  const navBg = await page
    .locator('[data-slot="tabs-list"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(navBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(navBg).not.toBe("transparent");

  // The Epic card's agent button (adapter · state) opens the Inspector.
  await page.locator("button.epic-agent").click();

  const inspector = page.locator('[data-slot="sheet-content"]');
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("role", "dialog");
  // Runner panel + timeline.
  await expect(inspector.getByText("controlled by")).toBeVisible();
  await expect(inspector.getByText("Event timeline")).toBeVisible();
});
