/**
 * Keyboard, focus and reflow checks of Settings → MCP (specs/030 phase 5; UX-10, MCP-CAT-25). The
 * file name sorts before `mcp-catalog.e2e.ts` on purpose: the first test needs MCP access to be
 * still ungranted, which the catalog journeys grant for the rest of the run.
 */
import { expect, type Page, test } from "@playwright/test";
import { card, login, openExplore, openMcp } from "./support.ts";

test.beforeEach(async ({ page }) => {
  await login(page);
  await openMcp(page);
});

test("the MCP access question takes the focus, Escape closes it and the focus comes back", async ({
  page,
}) => {
  const grant = page.getByRole("button", { name: "Grant MCP access" });
  await grant.click();
  const dialog = page.getByRole("alertdialog", { name: /MCP/ });
  await expect(dialog).toBeVisible();
  // The focus moves into the question, so a keyboard or screen reader user lands on it.
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(grant).toBeFocused();
});

/** The accessible name of the focused element, the way a screen reader would announce it. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    const labelled = el.getAttribute("aria-labelledby");
    const byId = labelled
      ? labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    // A control inside a label is named by the label's own text, not by its options.
    const labels = (el as HTMLInputElement).labels;
    const label = labels?.[0];
    const wrapped = !label
      ? ""
      : el instanceof HTMLSelectElement
        ? [...label.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join(" ")
        : (label.textContent ?? "");
    const own = el.getAttribute("aria-label") ?? byId ?? "";
    return (own || wrapped || el.textContent || el.getAttribute("placeholder") || "")
      .replace(/\s+/g, " ")
      .trim();
  });
}

test("the Explore tab is usable in order by keyboard and every stop has a name", async ({
  page,
}) => {
  await openExplore(page);
  await page.getByRole("searchbox", { name: "Search MCP servers" }).focus();
  const stops: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    const visible = await page.locator(":focus").isVisible();
    expect(visible).toBe(true);
    const name = await focusedName(page);
    expect(name, `stop ${i + 1} has an accessible name`).not.toBe("");
    stops.push(name);
    if (
      await card(page, "Local Files")
        .getByRole("button", { name: "Details" })
        .evaluate((el) => el === document.activeElement)
    )
      break;
  }
  // Filters come before the results, and the results are reachable.
  expect(stops.join(" | ")).toMatch(/Category/i);
  expect(stops.at(-1)).toMatch(/Details|Detalles/);
  // Enter opens the details and Escape-free navigation continues from the card's heading.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /About Local Files/ })).toBeFocused();
});

for (const width of [360, 640]) {
  test(`nothing is cut off horizontally at ${width} px (zoom 200% reaches 640 px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openExplore(page);
    await card(page, "Notes Cloud").getByRole("button", { name: "Details" }).click();
    const overflow = await page.evaluate(() => {
      // Elements that scroll or clip on purpose (a wide code block, a tab strip) are not cut-off controls.
      const clipped = (el: HTMLElement, root: Element) => {
        for (let p = el.parentElement; p && p !== root; p = p.parentElement)
          if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true;
        return false;
      };
      const worst = (root: Element) => {
        const edge = root.getBoundingClientRect().right;
        let max = 0;
        for (const el of root.querySelectorAll<HTMLElement>(
          "button, input, select, a, h4, h5, p",
        )) {
          const box = el.getBoundingClientRect();
          if (box.width && !clipped(el, root)) max = Math.max(max, box.right - edge);
        }
        return max;
      };
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? worst(dialog) : 0;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
