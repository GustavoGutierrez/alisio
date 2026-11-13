/**
 * Browser E2E of the MCP catalog (specs/030 O10). Optional and outside the default checklist:
 * `pnpm build && pnpm test:e2e`. It drives the built server and web UI with a fake catalog, a local
 * MCP server, a local OAuth authorization server and a scripted provider (see `e2e/stack.ts`).
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One server, one browser at a time: the journeys share the stack and are not independent runs.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
