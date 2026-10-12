export default {
  testRunner: "command",
  // Calls vitest directly (not through `pnpm exec`): the wrapper doubled the cost of every mutant.
  // `--bail=1` stops at the first failing test (most mutants die in the first file); one worker with
  // no isolation costs a third of the CPU of the default pool for the same wall time.
  commandRunner: {
    command:
      "node node_modules/vitest/vitest.mjs run --config vitest.mutation.config.ts --bail=1 --no-isolate --maxWorkers=1",
  },
  // The sandbox copy skips what no mutation test reads.
  ignorePatterns: ["docs", "specs", ".git", ".atl", "packages/*/dist", "packages/web", "scripts"],
  coverageAnalysis: "off",
  tsconfigFile: "tsconfig.stryker-none.json",
  mutate: [
    // Lite scope (owner limit: a cold run must finish in 2 minutes): only the security-relevant pure
    // decision modules. frame-parser, backend-selector, import-scan and state-delta keep their tests
    // in `pnpm test` but are not mutated (a cold run with them took 4m35s for 1153 mutants).
    "packages/core/src/forge/limits.ts",
    "packages/core/src/forge/state-machine.ts",
    "packages/core/src/forge/protocol.ts",
    "packages/core/src/forge/session-path.ts",
    "packages/core/src/permissions/decide.ts",
  ],
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
  concurrency: 2,
  timeoutMS: 5000,
  thresholds: { high: 80, low: 65, break: 60 },
  mutator: { excludedMutations: ["StringLiteral", "Regex", "ObjectLiteral", "ArrayDeclaration"] },
  checkers: [],
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
};
