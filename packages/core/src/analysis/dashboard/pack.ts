/**
 * The provider-agnostic Decision Pack `smart-dashboard-v1` (spec 6.2): a request built from the
 * candidates, and the table that turns the answers back into plan choices. Every option key is an
 * opaque column alias; the `state` carries the goal and column metadata, never a cell value (O4).
 * Pure.
 */
import type {
  DashboardLocale,
  DecisionAnswer,
  DecisionDefinition,
  DecisionRequest,
  DecisionResponse,
  JsonValue,
} from "@alisio/sdk";
import type { Candidates } from "./candidates.ts";
import { clip } from "./labels.ts";
import type { PlanChoices } from "./planner.ts";
import type { ProfiledColumn } from "./profile.ts";
import { PURPOSES } from "./spec.ts";

export const SMART_DASHBOARD_PACK = { id: "smart-dashboard-v1", version: 1 } as const;

/** The goal is the user's own text, bounded; the labels are column headers. */
export const PACK_LIMITS = { goal: 500, label: 60 } as const;

const PURPOSE_OPTIONS: Record<(typeof PURPOSES)[number], string> = {
  executive: "Executive: a few headline KPIs, a trend and the main breakdowns",
  operational: "Operational: monitoring, with a detail table and breakdowns first",
  analytical: "Analytical: exploring and comparing, with correlations and detail",
};

type Choice = keyof PlanChoices;

/**
 * The only questions the provider is asked; the rules decide everything else. Measured on 2026-10-03
 * with a real decision engine on 375 labelled decisions built like this pack (~half Spanish): `purpose`
 * was 90 % correct, while the column selects (`primaryMeasure`, `rankingDimension`,
 * `compositionDimension`) and the boolean toggles (`includeTrend`, `includeRanking`,
 * `includeComposition`, `includeCorrelation`) were near chance (the multilingual checkpoint answers
 * `true` 78 % of the time against 52 % in the labels). Latency also grows with the question count
 * (about 7 decisions: p50 2.1 s, p95 3.1 s, over the 1500 ms timeout; one decision: p50 0.30 s).
 * Adding a key needs new measured evidence that the provider beats the rules for it (the admission
 * rule in CONTRIBUTING.md). Answers for any other key are ignored when interpreting.
 */
export const PROVIDER_DECISIONS: readonly Choice[] = ["purpose"];

export interface SmartDashboardPack {
  /** `null` when no question is worth asking (nothing to chart). */
  request: DecisionRequest | null;
  /** Usable answers to plan choices, by table; anything unexpected is ignored. */
  interpret(response: DecisionResponse | null): Partial<PlanChoices>;
}

function describe(column: ProfiledColumn): string {
  return `${clip(column.label || column.name, PACK_LIMITS.label)} (${column.role}, ${column.cardinality})`;
}

function aliasOptions(columns: ProfiledColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map((c) => [c.alias, describe(c)]));
}

function toggle(
  instruction: string,
  trueMeaning: string,
  falseMeaning: string,
): DecisionDefinition {
  return { type: "boolean", instruction, trueMeaning, falseMeaning };
}

export function buildPack(input: {
  goal: string;
  locale: DashboardLocale;
  candidates: Candidates;
}): SmartDashboardPack {
  const { candidates } = input;
  const { measures, dimensions, time, compositionDims } = candidates;
  const hasCount = dimensions.length > 0 || time.length > 0;
  if (measures.length + dimensions.length + time.length === 0)
    return { request: null, interpret: () => ({}) };

  const all: Record<string, DecisionDefinition> = {
    purpose: {
      type: "select",
      instruction: "Pick the dashboard purpose that best fits the user's goal.",
      options: { ...PURPOSE_OPTIONS },
    },
  };
  if (measures.length >= 2)
    all.primaryMeasure = {
      type: "select",
      instruction: "Pick the measure the dashboard should lead with.",
      options: aliasOptions(measures),
    };
  if (time.length >= 1 && measures.length >= 1)
    all.includeTrend = toggle(
      "Should the dashboard show how the main measure evolves over time?",
      "Include a trend chart",
      "Leave the trend out",
    );
  if (dimensions.length >= 1 && (measures.length >= 1 || hasCount))
    all.includeRanking = toggle(
      "Should the dashboard rank the categories of a dimension by the main measure?",
      "Include a ranking chart",
      "Leave the ranking out",
    );
  if (dimensions.length >= 2)
    all.rankingDimension = {
      type: "select",
      instruction: "Pick the dimension whose categories the ranking should compare.",
      options: aliasOptions(dimensions),
    };
  if (compositionDims.length >= 1)
    all.includeComposition = toggle(
      "Should the dashboard show the share of each category in the total?",
      "Include a composition chart",
      "Leave the composition out",
    );
  if (compositionDims.length >= 2)
    all.compositionDimension = {
      type: "select",
      instruction: "Pick the dimension whose shares the composition chart should show.",
      options: aliasOptions(compositionDims),
    };
  if (measures.length >= 2)
    all.includeCorrelation = toggle(
      "Should the dashboard relate two measures in a scatter chart?",
      "Include a scatter chart",
      "Leave the scatter chart out",
    );

  // Only the allowlisted questions reach the provider; the rest stay with the rules.
  const decisions: Record<string, DecisionDefinition> = Object.fromEntries(
    Object.entries(all).filter(([key]) => (PROVIDER_DECISIONS as readonly string[]).includes(key)),
  );

  // The columns the provider may name: the shortlists, by position in the dataset.
  const named = [
    ...new Map([...measures, ...dimensions, ...time].map((c) => [c.alias, c])).values(),
  ].sort((a, b) => a.ordinal - b.ordinal);
  const state: JsonValue = {
    goal: clip(input.goal, PACK_LIMITS.goal),
    columns: named.map((c) => ({
      id: c.alias,
      label: clip(c.label || c.name, PACK_LIMITS.label),
      role: c.role,
      type: c.type,
      cardinality: c.cardinality,
    })),
  };
  const request: DecisionRequest = {
    version: 1,
    id: SMART_DASHBOARD_PACK.id,
    language: input.locale,
    pack: { ...SMART_DASHBOARD_PACK },
    state,
    decisions,
  };

  const byAlias = (list: ProfiledColumn[]) => new Map(list.map((c) => [c.alias, c.name]));
  const tables: Partial<Record<Choice, Map<string, string>>> = {
    primaryMeasure: byAlias(measures),
    rankingDimension: byAlias(dimensions),
    compositionDimension: byAlias(compositionDims),
  };
  const selects = new Set<Choice>(["primaryMeasure", "rankingDimension", "compositionDimension"]);
  const toggles = [
    "includeTrend",
    "includeRanking",
    "includeComposition",
    "includeCorrelation",
  ] as const;

  function interpret(response: DecisionResponse | null): Partial<PlanChoices> {
    const answers = response?.decisions;
    if (!answers || typeof answers !== "object") return {};
    const out: Record<string, unknown> = {};
    const answerOf = (key: string): DecisionAnswer | undefined =>
      Object.hasOwn(decisions, key) && Object.hasOwn(answers, key) ? answers[key] : undefined;

    const purpose = answerOf("purpose");
    if (purpose?.type === "select" && (PURPOSES as readonly string[]).includes(purpose.value))
      out.purpose = purpose.value;
    for (const key of selects) {
      const answer = answerOf(key);
      if (answer?.type !== "select") continue;
      const name = tables[key]?.get(answer.value);
      if (name !== undefined) out[key] = name;
    }
    for (const key of toggles) {
      const answer = answerOf(key);
      if (answer?.type === "boolean" && typeof answer.value === "boolean") out[key] = answer.value;
    }
    return out as Partial<PlanChoices>;
  }

  return { request, interpret };
}
