import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { runScenario, scenarioNames } from "../fixtures/scenarios.ts";

const env = {
  ALISIO_CONFIG_HOME: "/nonexistent-alisio-test",
  ALISIO_MODEL: "",
  OPENAI_BASE_URL: "",
  ALISIO_API_MODE: "",
};

/**
 * The `search` scenario needs the ripgrep binary on PATH. When it is missing the test must SKIP
 * cleanly (never fail); when rg exists the scenario still runs and fails on genuine breakage.
 */
const rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
const searchTitle = rgAvailable
  ? "search"
  : "search (skipped: ripgrep not installed; see alisio doctor for install commands)";

describe("integration contracts on Node", () => {
  beforeAll(() => {
    Object.assign(process.env, env);
  });
  for (const scenario of scenarioNames)
    it.skipIf(scenario === "search" && !rgAvailable)(
      scenario === "search" ? searchTitle : scenario,
      async () => {
        expect(await runScenario(scenario)).toEqual({ scenario, ok: true });
      },
      20_000,
    );
});

// The same fixtures still run on Bun (the standalone binary runtime) for storage, plugins and memory.
const execute = promisify(execFile);
describe("integration contracts on Bun", () => {
  for (const scenario of [
    "store-recovery",
    "store-migration",
    "memory-store",
    "plugin-hooks",
    "agent-loop",
  ])
    it(scenario, async () => {
      const { stdout } = await execute(
        resolve("node_modules/bun/bin/bun.exe"),
        ["--conditions=alisio-source", "fixtures/scenarios.ts", scenario],
        { timeout: 15_000, env: { ...process.env, ...env } },
      );
      expect(JSON.parse(stdout.trim())).toEqual({ scenario, ok: true });
    }, 20_000);
});
