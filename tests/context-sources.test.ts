import { describe, expect, it } from "vitest";
import { createInvariantSources } from "../packages/core/src/context/sources.ts";

const plan = (status: string) =>
  ({
    planId: "p1",
    revision: 4,
    hash: "c".repeat(64),
    title: "Plan",
    status,
    artifactId: "a1",
    updatedAt: 1,
  }) as never;

function build(over: Partial<Parameters<typeof createInvariantSources>[0]> = {}) {
  return createInvariantSources({
    goal: () => undefined,
    plan: () => undefined,
    criteria: () => [],
    externalDirectories: () => 0,
    ...over,
  });
}

describe("createInvariantSources", () => {
  it.each(["active", "paused", "blocked", "budget_limited"])("reports a %s goal", (status) => {
    const src = build({ goal: () => ({ goalId: "g1", objective: "Ship it", status }) as never });
    expect(src.goal?.("s")).toEqual({ goalId: "g1", objective: "Ship it" });
  });

  it("drops a completed goal and a missing one", () => {
    expect(
      build({ goal: () => ({ goalId: "g", objective: "x", status: "complete" }) as never }).goal?.(
        "s",
      ),
    ).toBeUndefined();
    expect(build().goal?.("s")).toBeUndefined();
  });

  it.each(["approved", "implementing"])("reports a %s plan", (status) => {
    expect(build({ plan: () => plan(status) }).plan?.("s")).toEqual({
      planId: "p1",
      revision: 4,
      hash: "c".repeat(64),
      title: "Plan",
      artifactId: "a1",
    });
  });

  it.each(["pending", "skipped", "feedback", "cancelled"])("ignores a %s plan", (status) => {
    expect(build({ plan: () => plan(status) }).plan?.("s")).toBeUndefined();
  });

  it("keeps the text and required flag of criteria and excludes not-applicable ones", () => {
    const src = build({
      criteria: () =>
        [
          { criterionId: "c1", text: "tests pass", required: true, scope: ["src/**"] },
          { criterionId: "c2", text: "skipped", required: true, notApplicableReason: "no UI" },
          { criterionId: "c3", text: "docs", required: false },
        ] as never,
    });
    expect(src.criteria?.("s")).toEqual([
      { criterionId: "c1", text: "tests pass", required: true },
      { criterionId: "c3", text: "docs", required: false },
    ]);
  });

  it("reports granted capabilities and only a count of external directories", () => {
    const asked: string[] = [];
    const src = build({
      capabilities: {
        granted: (capability, session) => {
          asked.push(`${capability}@${session}`);
          return capability === "analysis.run";
        },
      },
      externalDirectories: () => 3,
    });
    expect(src.grants?.("s1")).toEqual({ capabilities: ["analysis.run"], externalDirectories: 3 });
    expect(asked).toContain("analysis.run@s1");
  });

  it("works without a capability gate", () => {
    expect(build().grants?.("s")).toEqual({ capabilities: [], externalDirectories: 0 });
  });
});
