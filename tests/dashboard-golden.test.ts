/**
 * Golden specs (ADR-7): the `DashboardSpec` the rule planner returns for a few small, fixed
 * datasets. Hand-reviewable JSON in `tests/golden/dashboard/`; behavior at the planner boundary
 * (dataset + goal in, spec out), never the HTML. A rule change that moves a golden is meant to
 * be reviewed by a person, not regenerated blindly.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionAnswer, DecisionRequest, DecisionResponse } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleBasedPlanner, validateSpec } from "../packages/core/src/analysis/dashboard/index.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

const root = join(import.meta.dirname, "..");
const goldenDir = join(import.meta.dirname, "golden", "dashboard");

const WEST = ["North", "South", "East", "West"];
const CHANNELS = ["Web", "Store", "Marketplace"];
const PRODUCTS = ["Monitor", "Chair", "Mouse", "Desk", "Lamp", "Cable"];

/** 36 orders, one every 5 days from 2025-01-05; a fixed formula, no randomness. */
function salesRows(): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < 36; i++) {
    const day = new Date(Date.UTC(2025, 0, 5 + i * 5)).toISOString().slice(0, 10);
    const units = (i % 7) + 1;
    const price = 20 + (i % 6) * 15 + (i % 4);
    const amount = units * price;
    rows.push([
      `ORD-${String(i + 1).padStart(3, "0")}`,
      day,
      WEST[i % 4] as string,
      CHANNELS[i % 3] as string,
      PRODUCTS[(i * 5) % 6] as string,
      String(units),
      String(amount),
      String(Math.round(amount * (0.15 + (i % 5) / 50))),
    ]);
  }
  return rows;
}

const csv = (header: string[], rows: string[][]): string =>
  `${[header, ...rows].map((r) => r.join(",")).join("\n")}\n`;

/** 30 tickets over 4 weeks, daily. */
function operationsCsv(): string {
  const teams = ["Support", "Billing", "Logistics", "Platform"];
  const states = ["Open", "Done", "Done", "Blocked"];
  const rows: string[][] = [];
  for (let i = 0; i < 30; i++)
    rows.push([
      `T-${String(i + 1).padStart(3, "0")}`,
      new Date(Date.UTC(2025, 2, 1 + i)).toISOString().slice(0, 10),
      teams[i % 4] as string,
      states[(i * 3) % 4] as string,
      String(1 + ((i * 7) % 9) + (i % 2) / 2),
      String(30 + ((i * 13) % 25) * 2),
    ]);
  return csv(["ticket_id", "created", "team", "status", "hours", "cost"], rows);
}

/** Opaque names: nothing in the headers says what the columns mean. */
function opaqueCsv(): string {
  const rows: string[][] = [];
  for (let i = 0; i < 24; i++)
    rows.push([
      `x${String(i + 1).padStart(3, "0")}`,
      new Date(Date.UTC(2024, 5, 1 + i * 20)).toISOString().slice(0, 10),
      ["k1", "k2", "k3", "k4", "k5"][i % 5] as string,
      String(100 + ((i * 37) % 90) + (i % 3) / 4),
      String(((i * 53) % 400) + 1),
      String(i % 3),
    ]);
  return csv(["a", "b", "c", "d", "e", "f"], rows);
}

interface Case {
  name: string;
  goal: string;
  locale: "en" | "es";
  /** CSV text, or a path under the repository to read in place. */
  source: { text: string } | { file: string };
}

const CASES: Case[] = [
  {
    name: "sales-en",
    goal: "executive overview of sales by region",
    locale: "en",
    source: {
      text: csv(
        ["order_id", "order_date", "region", "channel", "product", "units", "amount", "profit"],
        salesRows(),
      ),
    },
  },
  {
    name: "sales-es",
    goal: "análisis de ventas y utilidad",
    locale: "es",
    source: {
      text: csv(
        ["pedido_id", "fecha", "region", "canal", "producto", "unidades", "ventas", "utilidad"],
        salesRows(),
      ),
    },
  },
  {
    name: "operations-en",
    goal: "monitor the operational status",
    locale: "en",
    source: { text: operationsCsv() },
  },
  {
    name: "opaque-en",
    goal: "show me something useful",
    locale: "en",
    source: { text: opaqueCsv() },
  },
  {
    name: "example-simple-300-es",
    goal: "resumen ejecutivo de ventas",
    locale: "es",
    source: { file: "examples/data/dashboard_simple_300.csv" },
  },
  {
    name: "example-4000-en",
    goal: "analysis of net sales and profit",
    locale: "en",
    source: { file: "examples/data/dataset_dashboard_4000.csv" },
  },
  {
    name: "example-4000-en-goal",
    goal: "net sales by category, seller, discount and order status",
    locale: "en",
    source: { file: "examples/data/dataset_dashboard_4000.csv" },
  },
  {
    name: "example-simple-300-es-goal",
    goal: "ventas por categoría, vendedor y estado",
    locale: "es",
    source: { file: "examples/data/dashboard_simple_300.csv" },
  },
];

let fixture: DataFixture;
beforeEach(async () => {
  fixture = await dataFixture();
});
afterEach(async () => {
  await fixture.dispose();
});

async function sheetOf(source: Case["source"]) {
  const content = "text" in source ? source.text : await readFile(join(root, source.file));
  const { record } = await fixture.ingest("data.csv", content);
  const detail = fixture.service.detail(record).sheetDetails[0];
  if (!detail) throw new Error("no sheet");
  return detail;
}

/** A provider that answers every question, always with the first option / true. */
function eagerConsumer() {
  return {
    async tryDecide(request: DecisionRequest): Promise<DecisionResponse> {
      const decisions: Record<string, DecisionAnswer> = {};
      for (const [key, definition] of Object.entries(request.decisions)) {
        if (definition.type === "select")
          decisions[key] = {
            type: "select",
            value: Object.keys(definition.options)[0] as string,
            confidence: 1,
          };
        else if (definition.type === "boolean")
          decisions[key] = { type: "boolean", value: true, confidence: 1, probability: 1 };
      }
      return { provider: "eager", latencyMs: 1, decisions, rejected: {} };
    },
  };
}

describe("dashboard golden specs", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: the rule plan matches its golden file`, async () => {
      const sheet = await sheetOf(testCase.source);
      const result = await new RuleBasedPlanner().plan({
        sheet,
        goal: testCase.goal,
        locale: testCase.locale,
        title: "Golden",
      });
      if (!result.ok) throw new Error(`plan failed: ${result.error}`);
      expect(result.planner).toBe("rules");
      expect(validateSpec(result.spec, result.catalog).result).toBe("valid");
      const golden = JSON.parse(await readFile(join(goldenDir, `${testCase.name}.json`), "utf8"));
      expect(result.spec).toEqual(golden);
    });

    it(`${testCase.name}: a provider that answers everything still yields a valid spec`, async () => {
      const sheet = await sheetOf(testCase.source);
      const result = await new RuleBasedPlanner().plan({
        sheet,
        goal: testCase.goal,
        locale: testCase.locale,
        decisions: eagerConsumer(),
      });
      if (!result.ok) throw new Error(`plan failed: ${result.error}`);
      expect(result.planner).toBe("rules+decisions");
      expect(validateSpec(result.spec, result.catalog).result).toBe("valid");
    });
  }

  it("the golden files are small enough to review by hand", async () => {
    for (const testCase of CASES) {
      const text = await readFile(join(goldenDir, `${testCase.name}.json`), "utf8");
      expect(text.split("\n").length).toBeLessThan(200);
    }
  });
});
