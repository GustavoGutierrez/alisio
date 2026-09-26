import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["alisio-source"] },
  ssr: { resolve: { conditions: ["alisio-source"], externalConditions: ["alisio-source"] } },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});
