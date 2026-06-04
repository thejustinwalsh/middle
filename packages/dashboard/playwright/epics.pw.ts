/**
 * #224 Epics smoke: load `/`, the default Epics view shows the seeded Epic, and
 * clicking its runner chip opens the Inspector Sheet with the runner panel +
 * timeline.
 *
 * Updated for #234 (operator-console redesign): the page-level nav is the
 * Sidebar's `data-slot="sidebar"` aside, not the old shadcn `Tabs`. The Epic
 * card's runner chip is the wrapper button around the StatusChip — assert
 * the `data-slot="sidebar"` element is styled (Tailwind compiled) and click
 * the chip button via its `Open inspector for …` aria-label.
 */
import { expect, test } from "@playwright/test";

test("Epics: clicking an Epic's runner opens the Inspector with panel + timeline", async ({
  page,
}) => {
  await page.goto("/");

  // Epics is the default view; the seeded Epic card renders.
  await expect(page.getByText("OAuth refresh")).toBeVisible();

  // Tailwind actually compiled + applied (not just present in the DOM): the
  // Sidebar aside carries a real `bg-[color:var(--panel)]` background, not the
  // unstyled transparent default. Guards against the toolchain serving the SPA
  // without its styles.
  const navBg = await page
    .locator('[data-slot="sidebar"]')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(navBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(navBg).not.toBe("transparent");

  // The Epic card's agent chip (`adapter · state`) opens the Inspector. The
  // Epics component wraps the StatusChip in a `<button aria-label="Open
  // inspector for …">` when the inspector callback is wired.
  await page
    .getByRole("button", { name: /^Open inspector for / })
    .first()
    .click();

  const inspector = page.locator('[data-slot="sheet-content"]');
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("role", "dialog");
  // Runner panel + timeline.
  await expect(inspector.getByText("controlled by")).toBeVisible();
  await expect(inspector.getByText("Event timeline")).toBeVisible();
});
