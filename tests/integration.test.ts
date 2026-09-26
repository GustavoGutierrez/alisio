import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const bun = resolve("node_modules/bun/bin/bun.exe");
const scenarios = [
  "safe-path",
  "context-scope",
  "skills",
  "safe-edit",
  "ambiguous-edit",
  "search",
  "process-abort",
  "process-limit",
  "store-recovery",
  "completed-recovery",
  "plugin-rollback",
  "plugin-external",
  "config",
  "agent-loop",
  "policy",
  "scope-before-edit",
  "herdr-contract",
  "herdr-messaging",
  "herdr-noop",
  "compaction",
  "auto-compaction",
  "model-switch",
  "store-migration",
  "approval",
  "memory-store",
  "memory-migration",
  "memory-tools",
  "smart-compaction",
  "memory-session-start",
  "plugin-hooks",
  "memory-enabled-disabled",
];
describe("Bun integration contracts", () => {
  for (const scenario of scenarios)
    it(scenario, async () => {
      const { stdout } = await execute(bun, ["fixtures/scenarios.ts", scenario], {
        cwd: process.cwd(),
        timeout: 15000,
        env: {
          ...process.env,
          ALISIO_CONFIG_HOME: "/nonexistent-alisio-test",
          ALISIO_MODEL: "",
          OPENAI_BASE_URL: "",
          ALISIO_API_MODE: "",
        },
      });
      expect(JSON.parse(stdout.trim())).toEqual({ scenario, ok: true });
    }, 20000);
});
