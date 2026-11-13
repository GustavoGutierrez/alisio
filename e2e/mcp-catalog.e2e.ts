/**
 * Browser journeys of Settings → MCP (specs/030 phase 4; MCP-CAT-17/18/19/23/24/25): a person who
 * never opens a terminal or a JSON file explores, installs, checks, changes and removes an
 * integration, signs in to a service through a real (local) authorization server, and recovers from
 * the usual failures. The built server and web UI run against fakes (see `stack.ts`).
 */
import { expect, type Page, test } from "@playwright/test";
import { card, login, NOTES_KEY, openExplore, openMcp, row } from "./support.ts";

test.beforeEach(async ({ page }) => {
  await login(page);
  await openMcp(page);
});

test("search, read the details, install with a required key, check, change the key and remove it", async ({
  page,
}) => {
  await openExplore(page);
  await page.getByRole("searchbox", { name: "Search MCP servers" }).fill("notes");
  const notes = card(page, "Notes Cloud");
  await expect(notes).toBeVisible();

  // The detail card explains it in plain words (MCP-CAT-17).
  await notes.getByRole("button", { name: "Details" }).click();
  const detail = page.getByRole("region", { name: "About Notes Cloud" });
  await expect(detail).toContainText("Keep your notes");
  await expect(detail).toContainText("X-Api-Key (a key, saved protected)");
  await expect(detail).toContainText("Remote service");
  await detail.getByRole("button", { name: "Connect" }).click();

  // One compact form: an empty submit is refused, focus goes to the field and nothing is lost.
  const form = page.getByRole("form", { name: /Set up Notes Cloud/ });
  const key = form.getByLabel("X-Api-Key");
  await expect(key).toHaveAttribute("type", "password");
  await form.getByLabel(/I allow Alisio to run MCP servers/).check();
  await form.getByRole("button", { name: "Connect and test" }).click();
  await expect(form.getByRole("alert").first()).toContainText("required");
  await expect(key).toBeFocused();
  await expect(form.getByLabel("X-Api-Key")).toHaveValue("");

  await key.fill(NOTES_KEY);
  await form.getByRole("button", { name: "Connect and test" }).click();
  await expect(
    page.getByText(/Ready\. It offers 2 tools, 1 resources and 1 prompts\./),
  ).toBeVisible({
    timeout: 30_000,
  });
  await notes.getByRole("button", { name: "Close" }).click();

  // Connected: where it runs and where it is available are separate, in words (MCP-CAT-23).
  await page.getByRole("tab", { name: "Connected" }).click();
  const mine = row(page, "Notes Cloud");
  await expect(mine).toContainText("Remote service");
  await expect(mine).toContainText("Project · Contabilidad");
  await expect(mine).toContainText("Ready to use");
  await expect(mine).not.toContainText(NOTES_KEY);
  // The enable switch keeps its track shape (wider than tall) next to the 44 px action buttons.
  const track = await mine.getByRole("switch").boundingBox();
  expect(track && track.width > track.height * 1.4).toBe(true);

  // Check the connection: isolated, with its stages, and no tool is called.
  await mine.getByRole("button", { name: "Check connection" }).click();
  const check = mine.getByRole("group", { name: "Notes Cloud" });
  await expect(check).toContainText("Connected. The service answered", { timeout: 30_000 });
  await expect(check).toContainText(
    "It offers 2 tools, 1 resource and 0 prompts".replace("0 prompts", "1 prompt"),
  );
  await expect(
    check.getByRole("list", { name: "Stages of the check" }).getByRole("listitem"),
  ).toHaveCount(4);
  await check.getByRole("button", { name: "Close" }).click();
  await expect(check).toHaveCount(0);

  // Change the key to a wrong one: the check says so and offers the way out (MCP-CAT-25).
  await mine.getByRole("button", { name: "Configure" }).click();
  const settings = page.getByRole("form", { name: /Settings of/ });
  await expect(settings.getByText("Key saved")).toBeVisible();
  await settings.getByRole("button", { name: "Replace key" }).click();
  await settings.getByLabel("X-Api-Key").fill("sk-wrong-key");
  await settings.getByRole("button", { name: "Save and check" }).click();
  const failed = mine.getByRole("group", { name: "Notes Cloud" });
  await expect(failed).toContainText("We could not access your account", { timeout: 30_000 });
  await expect(mine).toContainText("Needs attention");
  await failed.getByRole("button", { name: "Change key" }).click();
  const again = page.getByRole("form", { name: /Settings of/ });
  await again.getByRole("button", { name: "Replace key" }).click();
  await again.getByLabel("X-Api-Key").fill(NOTES_KEY);
  await again.getByRole("button", { name: "Save and check" }).click();
  await expect(mine.getByRole("group", { name: "Notes Cloud" })).toContainText(
    "Connected. The service answered",
    { timeout: 30_000 },
  );
  await expect(mine).toContainText("Ready to use");

  // Remove it: the dialog says exactly what happens and that the account is untouched.
  await mine.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Disconnect/ }));
  await expect(dialog).toContainText("only from Contabilidad");
  await expect(dialog).toContainText("does not delete your account");
  // Escape cancels and the focus returns to the button that opened the dialog (UX-10).
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(mine.getByRole("button", { name: "Disconnect" })).toBeFocused();
  await mine.getByRole("button", { name: "Disconnect" }).click();
  await dialog.getByRole("button", { name: "Disconnect service" }).click();
  await expect(mine).toHaveCount(0);
});

/**
 * Starts an install from a card. When MCP consent is still missing the compact form asks for it (and
 * only for it); once it was granted in this run a single click is enough and no empty form appears
 * (UX-04, MCP-CAT-18).
 */
async function startInstall(page: Page, title: string, action: "Connect" | "Install") {
  const item = card(page, title);
  await item.getByRole("button", { name: action, exact: true }).click();
  const consent = item.getByLabel(/I allow Alisio to run MCP servers/);
  if (await consent.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await consent.check();
    await item.getByRole("button", { name: /and test$/ }).click();
  } else await expect(item.getByRole("textbox")).toHaveCount(0);
  return item;
}

test("sign in to a service with its own authorization server (OAuth)", async ({
  page,
  context,
}) => {
  await openExplore(page);
  await page.getByRole("searchbox", { name: "Search MCP servers" }).fill("ledger");
  const ledger = await startInstall(page, "Ledger Cloud", "Connect");
  await expect(ledger.getByText(/needs you to sign in/)).toBeVisible({ timeout: 30_000 });

  await ledger.getByRole("button", { name: "Connect my account" }).click();
  const link = ledger.getByRole("link", { name: "Open the sign-in page" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  const popup = context.waitForEvent("page");
  await link.click();
  const signIn = await popup;
  await signIn.getByRole("link", { name: "Allow access" }).click();
  await expect(signIn.getByRole("heading", { name: "Signed in" })).toBeVisible();
  await signIn.close();

  await expect(ledger.getByText("Signed in. The service is connecting.")).toBeVisible({
    timeout: 30_000,
  });
  await ledger.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tab", { name: "Connected" }).click();
  const mine = row(page, "Ledger Cloud");
  await expect(mine).toContainText("Connected", { timeout: 30_000 });
  await expect(mine.getByRole("button", { name: "Sign out" })).toBeVisible();

  // Sign out removes the local sign-in only, and the row asks for it again.
  await mine.getByRole("button", { name: "Sign out" }).click();
  await expect(mine).toContainText("Sign-in needed", { timeout: 30_000 });
  // The row with the most actions never squeezes its text: the name and the badges stay on one line each (UX-10).
  const name = await mine.getByText("Ledger Cloud", { exact: true }).first().boundingBox();
  expect(name?.height ?? 99).toBeLessThan(30);
  const badge = await mine.getByText("Remote service", { exact: true }).boundingBox();
  expect(badge?.height ?? 99).toBeLessThan(34);
  await expect(mine.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await mine.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Disconnect service" }).click();
  await expect(mine).toHaveCount(0);
});

test("a local package for everyone, an update from the list, and honest labels", async ({
  page,
}) => {
  await openExplore(page);
  await page.getByRole("searchbox", { name: "Search MCP servers" }).fill("files");
  // A web server's "local" is the computer running Alisio, never the browser's (MCP-CAT-23).
  await expect(card(page, "Local Files")).toContainText("On the computer running Alisio");
  await page.getByRole("radio", { name: /All my projects/ }).check();
  const files = await startInstall(page, "Local Files", "Install");
  await expect(files.getByText(/Ready\. It offers 2 tools/)).toBeVisible({ timeout: 60_000 });
  await files.getByRole("button", { name: "Close" }).click();

  await page.getByRole("tab", { name: "Connected" }).click();
  const mine = row(page, "Local Files");
  await expect(mine).toContainText("On the computer running Alisio");
  await expect(mine).toContainText("Global · All my projects");

  // Nothing newer yet; then a newer version appears in the catalog and the update goes through.
  await mine.getByRole("button", { name: "Update" }).click();
  await expect(mine.getByText(/You have the latest version \(1\.0\.0\)\./)).toBeVisible({
    timeout: 30_000,
  });
  await mine.getByRole("button", { name: "Close" }).click();
  const published = await fetch(`${process.env.E2E_CONTROL}/publish-update`, { method: "POST" });
  expect(published.status).toBe(204);
  await expect(async () => {
    await mine.getByRole("button", { name: "Update" }).click();
    await expect(mine.getByText("Version 1.0.0 → 1.1.0")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await mine.getByRole("button", { name: "Update and check" }).click();
  await expect(mine.getByText(/Ready\. It offers 2 tools/)).toBeVisible({ timeout: 60_000 });
  await mine.getByRole("button", { name: "Close" }).click();
  await expect(mine).toContainText("Connected");

  await mine.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Remove/ })),
  ).toContainText("all projects");
  await page.getByRole("button", { name: "Uninstall" }).last().click();
  await expect(mine).toHaveCount(0);
});

test("empty results, an unsupported method, keyboard use and a 360 px screen all lead somewhere", async ({
  page,
}) => {
  await openExplore(page);
  // No matches: a recovery action, not a dead end.
  const search = page.getByRole("searchbox", { name: "Search MCP servers" });
  await search.fill("zzzz-nothing");
  await expect(page.getByText("No MCP server matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(card(page, "Notes Cloud")).toBeVisible();

  // An entry Alisio cannot install says why and shows no install button.
  const python = card(page, "Python Tool");
  await expect(python).toContainText("Python (PyPI)");
  await expect(python.getByRole("button", { name: "Install" })).toHaveCount(0);

  // Keyboard: details open with Enter and the focus lands on the card's heading.
  const details = card(page, "Notes Cloud").getByRole("button", { name: "Details" });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "About Notes Cloud" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await card(page, "Notes Cloud").getByRole("button", { name: "Hide details" }).first().click();

  // 360 px: nothing is cut off horizontally and the main actions stay reachable.
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? dialog.scrollWidth - dialog.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await card(page, "Notes Cloud")
    .getByRole("button", { name: "Connect" })
    .boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
});

test("the Spanish interface carries the same journey", async ({ page }) => {
  await page.getByRole("button", { name: "General" }).click();
  await page.getByRole("radio", { name: "Español" }).check();
  await page.getByRole("button", { name: "Servidores MCP" }).click();
  await page.getByRole("tab", { name: "Explorar" }).click();
  await expect(card(page, "Notes Cloud")).toBeVisible({ timeout: 30_000 });
  await card(page, "Notes Cloud").getByRole("button", { name: "Detalles" }).click();
  await expect(page.getByRole("region", { name: "Acerca de Notes Cloud" })).toContainText(
    "Servicio remoto",
  );
  await expect(
    page.getByText("Aparecer en el catálogo no es una revisión de seguridad"),
  ).toBeVisible();
});
