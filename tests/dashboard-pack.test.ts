import type { DecisionAnswer, DecisionResponse } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCandidates,
  buildPack,
  PROVIDER_DECISIONS,
  profileSheet,
  SMART_DASHBOARD_PACK,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { DECISION_LIMITS, validateRequest } from "../packages/core/src/decisions/index.ts";
import { column, sheet } from "./dashboard-helpers.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

const measure = (name: string, extra: Parameters<typeof column>[2] = {}) =>
  column(name, "real", { distinct: 90, min: "1", max: "9", ...extra });
const dimension = (name: string, distinct: number) => column(name, "text", { distinct });
const time = (name: string) =>
  column(name, "date", { distinct: 90, min: "2024-01-01", max: "2024-12-31" });

function packOf(columns: ReturnType<typeof column>[], goal = "sales overview") {
  const candidates = buildCandidates(profileSheet(sheet(columns, { rows: 1000 })));
  return buildPack({ goal, locale: "en", candidates });
}

const FULL = [
  time("order_date"),
  measure("sales"),
  measure("profit"),
  dimension("region", 5),
  dimension("channel", 4),
];

const select = (value: string): DecisionAnswer => ({ type: "select", value, confidence: 0.9 });
const flag = (value: boolean): DecisionAnswer => ({
  type: "boolean",
  value,
  confidence: 0.9,
  probability: 0.9,
});
const response = (decisions: Record<string, DecisionAnswer>): DecisionResponse => ({
  provider: "fake",
  latencyMs: 1,
  decisions,
  rejected: {},
});

describe("dashboard pack: the request", () => {
  it("asks only the allowlisted questions, and satisfies the decision contract", () => {
    const { request } = packOf(FULL);
    expect(request).not.toBeNull();
    if (!request) return;
    expect(() => validateRequest(request)).not.toThrow();
    expect(request.id).toBe("smart-dashboard-v1");
    expect(request.pack).toEqual(SMART_DASHBOARD_PACK);
    expect(request.language).toBe("en");
    expect(PROVIDER_DECISIONS).toEqual(["purpose"]);
    expect(Object.keys(request.decisions)).toEqual(["purpose"]);
    expect(Object.keys(request.decisions).length).toBeLessThanOrEqual(DECISION_LIMITS.maxDecisions);
  });

  it("asks the purpose even when no other question has candidates", () => {
    const keys = Object.keys(
      packOf([measure("sales"), dimension("region", 5)]).request?.decisions ?? {},
    );
    expect(keys).toEqual(["purpose"]);
  });

  it("asks nothing when there is nothing to chart", () => {
    expect(packOf([column("id", "text", { distinct: 1000 })]).request).toBeNull();
  });

  it("offers the purpose options", () => {
    const purpose = packOf(FULL).request?.decisions.purpose;
    expect(purpose?.type === "select" && Object.keys(purpose.options)).toEqual([
      "executive",
      "operational",
      "analytical",
    ]);
  });

  it("builds the state from goal and column metadata only", () => {
    const goal = `${"g".repeat(700)}`;
    const { request } = packOf(FULL, goal);
    const state = request?.state as { goal: string; columns: Array<Record<string, unknown>> };
    expect(state.goal).toHaveLength(500);
    expect(state.columns.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5"].sort());
    for (const entry of state.columns)
      expect(Object.keys(entry).sort()).toEqual(["cardinality", "id", "label", "role", "type"]);
  });

  it("clips labels to 60 characters and leaves out identifiers and unknown columns", () => {
    const { request } = packOf([
      measure("sales", { label: "x".repeat(100) }),
      column("order_id", "text", { distinct: 1000 }),
      dimension("region", 5),
    ]);
    const state = request?.state as { columns: Array<{ id: string; label: string }> };
    expect(state.columns.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(state.columns[0]?.label.length).toBeLessThanOrEqual(60);
  });
});

describe("dashboard pack: privacy of the state (O4)", () => {
  let fixture: DataFixture;
  beforeEach(async () => {
    fixture = await dataFixture();
  });
  afterEach(async () => {
    await fixture.dispose();
  });

  it("never carries cell values, frequent values, minimum, maximum or samples", async () => {
    const SECRET_TEXT = "ZQXJ-SENTINEL-CELL";
    const SECRET_REGION = "Sentinelandia-Norte";
    const SECRET_NUMBER = "987654.321";
    const SECRET_DATE = "1987-06-05";
    const lines = ["order_id,order_date,region,notes,amount,units"];
    for (let i = 1; i <= 30; i++) {
      const region = i % 3 === 0 ? SECRET_REGION : i % 3 === 1 ? "West" : "East";
      const date = i === 1 ? SECRET_DATE : `2024-0${(i % 9) + 1}-1${i % 9}`;
      const amount = i === 2 ? SECRET_NUMBER : `${i * 10}.5`;
      lines.push(
        `ORD-${i},${date},${region},${i === 3 ? SECRET_TEXT : `note ${i}`},${amount},${i % 7}`,
      );
    }
    const { record } = await fixture.ingest("secret.csv", `${lines.join("\n")}\n`);
    const detail = fixture.service.detail(record);
    const candidates = buildCandidates(profileSheet(detail.sheetDetails[0] ?? sheet([])));
    // sanity: the sentinels really are in the statistics the profiler read
    const wire = JSON.stringify(detail.sheetDetails);
    expect(wire).toContain(SECRET_REGION);
    expect(wire).toContain(SECRET_NUMBER);
    expect(wire).toContain(SECRET_DATE);
    const { request } = buildPack({ goal: "overview of sales", locale: "en", candidates });
    expect(request).not.toBeNull();
    const sent = JSON.stringify(request);
    for (const secret of [SECRET_TEXT, SECRET_REGION, SECRET_NUMBER, SECRET_DATE, "West", "East"])
      expect(sent).not.toContain(secret);
    expect(sent).not.toMatch(/"(top|min|max|mean|samples?|values?|examples?)"/);
  });
});

describe("dashboard pack: interpreting answers", () => {
  const pack = () => packOf(FULL);

  it("maps the purpose answer", () => {
    expect(pack().interpret(response({ purpose: select("analytical") }))).toEqual({
      purpose: "analytical",
    });
  });

  it("returns nothing without a response", () => {
    expect(pack().interpret(null)).toEqual({});
    expect(pack().interpret(response({}))).toEqual({});
  });

  it("ignores values outside the options, answers of the wrong type and unknown keys", () => {
    expect(pack().interpret(response({ purpose: select("hax"), invented: flag(true) }))).toEqual(
      {},
    );
    expect(pack().interpret(response({ purpose: flag(true) }))).toEqual({});
  });

  it("ignores answers for keys outside the allowlist, even well-formed ones", () => {
    const answers = response({
      purpose: select("executive"),
      primaryMeasure: select("c3"),
      rankingDimension: select("c5"),
      compositionDimension: select("c4"),
      includeTrend: flag(false),
      includeRanking: flag(false),
      includeComposition: flag(false),
      includeCorrelation: flag(true),
    });
    expect(pack().interpret(answers)).toEqual({ purpose: "executive" });
  });
});
