import { expect, type Page } from "@playwright/test";

export const NOTES_KEY = "sk-notes-E2E-0123456789";

export async function login(page: Page): Promise<void> {
  await page.goto(`${process.env.E2E_BASE_URL}/?token=${process.env.E2E_TOKEN}`);
  await expect(page.getByRole("button", { name: "Settings & tools" })).toBeVisible();
}

/** Settings → MCP servers, the way a person gets there. */
export async function openMcp(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings & tools" }).click();
  await page.getByRole("menuitem", { name: /^Settings/ }).click();
  await page.getByRole("button", { name: "MCP servers" }).click();
  await expect(page.getByRole("tab", { name: "Explore" })).toBeVisible();
}

export async function openExplore(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Explore" }).click();
  // The catalog syncs in the background the first time.
  await expect(
    page.getByRole("list", { name: /Servers|MCP servers|results/i }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
}

/** The card of one catalog entry. */
export const card = (page: Page, title: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });

/** The row of one connected server. */
export const row = (page: Page, title: string) =>
  page
    .getByRole("listitem")
    .filter({ hasText: title })
    .filter({ has: page.getByRole("switch") });
