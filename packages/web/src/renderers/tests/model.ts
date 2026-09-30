/** Pure helpers of the `test-results` renderer: counts and the "failures only" filter. */
import type { UiBlock } from "@alisio/sdk";

type TestsBlock = Extract<UiBlock, { kind: "test-results" }>;
type Suite = TestsBlock["suites"][number];

export function summarize(block: Pick<TestsBlock, "suites">) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const suite of block.suites)
    for (const c of suite.cases) {
      counts[c.status]++;
      counts.total++;
    }
  return counts;
}

/** Suites reduced to their failed cases; suites without failures disappear. */
export function failedOnly(suites: Suite[]): Suite[] {
  return suites
    .map((suite) => ({ ...suite, cases: suite.cases.filter((c) => c.status === "failed") }))
    .filter((suite) => suite.cases.length > 0);
}
