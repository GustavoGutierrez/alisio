import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["alisio-source"] },
  ssr: { resolve: { conditions: ["alisio-source"], externalConditions: ["alisio-source"] } },
  test: {
    include: [
      "tests/forge-limits.test.ts",
      "tests/forge-state-machine.test.ts",
      "tests/forge-protocol.test.ts",
      "tests/forge-session-path.test.ts",
      "tests/forge-decide-effect.test.ts",
    ],
    testTimeout: 30_000,
  },
});
