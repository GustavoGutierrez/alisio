import { execFile } from "node:child_process";
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

describe("integration contracts on Node", () => {
  beforeAll(() => {
    Object.assign(process.env, env);
  });
  for (const scenario of scenarioNames)
    it(scenario, async () => {
      expect(await runScenario(scenario)).toEqual({ scenario, ok: true });
    }, 20_000);
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
