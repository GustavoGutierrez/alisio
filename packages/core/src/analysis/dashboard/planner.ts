/**
 * The planner (spec 6.2, ADR-1): rules first, decisions on top. `RuleBasedPlanner` always computes
 * a complete plan from the rules; the usable answers of a decision consumer replace their rule
 * default key by key, and rejected or missing keys keep the rule. One code path, with or without a
 * provider. Pure apart from awaiting the consumer.
 */
import type {
  DashboardLocale,
  DashboardPurpose,
  DashboardSpec,
  DashboardWidget,
  DecisionResponse,
  ToolDecisions,
} from "@alisio/sdk";
import { buildCandidates, type Candidates } from "./candidates.ts";
import { goalColumns, unnamedGoalText, withGoalColumns } from "./goal.ts";
import { columnTokens, hintsOf, MEASURE_SYNONYMS, normalizeName, PURPOSE_WORDS } from "./hints.ts";
import {
  byTitle,
  clip,
  defaultTitle,
  displayName,
  kpiLabel,
  rowsLabel,
  scatterTitle,
  shareTitle,
  tableTitle,
  trendTitle,
} from "./labels.ts";
import { buildPack } from "./pack.ts";
import { type ProfiledColumn, profileSheet, type SheetDetail } from "./profile.ts";
import { PURPOSE_LAYOUT, priorityOf, SPEC_LIMITS, timeBucketFor } from "./spec.ts";
import { validateSpec } from "./validate.ts";

export interface PlanChoices {
  purpose: DashboardPurpose;
  /** Column names (never aliases): the pack translates answers before they get here. */
  primaryMeasure?: string;
  includeTrend: boolean;
  includeRanking: boolean;
  rankingDimension?: string;
  includeComposition: boolean;
  compositionDimension?: string;
  includeCorrelation: boolean;
  /** Column names the goal names, in the goal's order: measures, and dimensions (never identifiers). */
  goalMeasures?: string[];
  goalDimensions?: string[];
}

function purposeOf(goal: string): DashboardPurpose {
  const text = normalizeName(goal);
  for (const entry of PURPOSE_WORDS)
    if (entry.words.some((word) => text.includes(word))) return entry.purpose;
  return "executive";
}

/**
 * The measure the goal names through the synonym table, preferring measures that are not rates.
 * Among several that satisfy a synonym, the one sharing the most words with the goal wins; a tie
 * keeps the candidate order.
 */
function measureFromGoal(goal: string, measures: ProfiledColumn[]): ProfiledColumn | undefined {
  const text = normalizeName(goal);
  const goalWords = new Set(text.split("_").filter((word) => word.length >= 3));
  const additive = measures.filter((m) => !hintsOf(m.name, m.label).average);
  for (const group of MEASURE_SYNONYMS) {
    if (!group.goal.some((word) => text.includes(word))) continue;
    for (const pool of [additive, measures]) {
      let best: ProfiledColumn | undefined;
      let bestOverlap = -1;
      for (const m of pool) {
        const tokens = columnTokens(m.name, m.label);
        if (![...tokens].some((token) => group.column.has(token))) continue;
        const overlap = [...tokens].filter((token) => goalWords.has(token)).length;
        if (overlap > bestOverlap) {
          best = m;
          bestOverlap = overlap;
        }
      }
      if (best) return best;
    }
  }
  return additive[0] ?? measures[0];
}

const named = (list: ProfiledColumn[], name: string | undefined): ProfiledColumn | undefined =>
  name === undefined ? undefined : list.find((c) => c.name === name);

/**
 * The rule plan choices. An override replaces the default of its own key, and the defaults that
 * depend on it follow (purpose, ranking dimension) so the plan stays coherent.
 */
export function ruleBasedChoices(input: {
  goal: string;
  candidates: Candidates;
  /** The columns of the sheet the goal is matched against; default the shortlists. */
  catalog?: ProfiledColumn[];
  overrides?: Partial<PlanChoices>;
}): PlanChoices {
  const { measures, dimensions, time, compositionDims } = input.candidates;
  const over = input.overrides ?? {};
  const pool =
    input.catalog ??
    [...new Set([...measures, ...dimensions, ...time])].sort((a, b) => a.ordinal - b.ordinal);
  const matches = goalColumns(input.goal, pool);
  const matched = matches.map((m) => m.column);
  const purpose = over.purpose ?? purposeOf(unnamedGoalText(input.goal, matches));
  const goalMeasures = matched.filter((c) => c.role === "measure");
  const goalDimensions = matched.filter((c) => c.role === "dimension" || c.role === "boolean");
  // a measure the goal names leads; a rate cannot lead because the plan sums its primary
  const goalPrimary = goalMeasures.find(
    (c) => !hintsOf(c.name, c.label).average && measures.includes(c),
  );
  const primary =
    named(measures, over.primaryMeasure) ?? goalPrimary ?? measureFromGoal(input.goal, measures);
  const ranking =
    named(dimensions, over.rankingDimension) ??
    dimensions.find((c) => c.distinct >= 3) ??
    dimensions[0];
  const composition =
    named(compositionDims, over.compositionDimension) ??
    compositionDims.find((c) => c.name !== ranking?.name) ??
    compositionDims[0];

  const compositionDefault =
    composition !== undefined && (purpose !== "analytical" || composition.distinct <= 5);
  return {
    purpose,
    ...(primary ? { primaryMeasure: primary.name } : {}),
    includeTrend: time.length > 0 && (over.includeTrend ?? true),
    includeRanking: ranking !== undefined && (over.includeRanking ?? true),
    ...(ranking ? { rankingDimension: ranking.name } : {}),
    includeComposition:
      composition !== undefined && (over.includeComposition ?? compositionDefault),
    ...(composition ? { compositionDimension: composition.name } : {}),
    includeCorrelation:
      measures.length >= 2 && (over.includeCorrelation ?? purpose === "analytical"),
    ...(goalMeasures.length ? { goalMeasures: goalMeasures.map((c) => c.name) } : {}),
    ...(goalDimensions.length ? { goalDimensions: goalDimensions.map((c) => c.name) } : {}),
  };
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Widget ids are readable, valid and unique: a suffix breaks the rare collision after clipping. */
function idFactory() {
  const used = new Set<string>();
  return (base: string): string => {
    const root = (/^[a-z]/.test(base) ? base : `w-${base}`).slice(0, 40).replace(/-+$/, "");
    let id = root;
    for (let n = 2; used.has(id); n++) id = `${root.slice(0, 40 - String(n).length - 1)}-${n}`;
    used.add(id);
    return id;
  };
}

const TABLE_COLUMNS = 8;
const TABLE_ROWS = 10;
const RANKING_LIMIT = 10;
const COMPOSITION_LIMIT = 5;
const COMPOSITION_BARS = 8;
/** Measure KPIs of a default plan (the row count comes on top); named measures may raise it. */
const DEFAULT_MEASURE_KPIS = 4;
const MAX_MEASURE_KPIS = SPEC_LIMITS.kpis - 1;

/** The columns of the detail table: the best time column, up to 3 dimensions, then measures; in dataset order. */
function tableColumns(candidates: Candidates): string[] {
  const picked: ProfiledColumn[] = [];
  const first = candidates.time[0];
  if (first) picked.push(first);
  picked.push(...candidates.dimensions.slice(0, 3));
  for (const measure of candidates.measures)
    if (picked.length < TABLE_COLUMNS) picked.push(measure);
  return picked
    .slice(0, TABLE_COLUMNS)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.name);
}

export function planDashboard(input: {
  title: string;
  locale: DashboardLocale;
  choices: PlanChoices;
  candidates: Candidates;
  sheet?: string;
}): DashboardSpec {
  const { locale, choices, candidates } = input;
  const { measures, dimensions, time, compositionDims } = candidates;
  const id = idFactory();
  const primary = named(measures, choices.primaryMeasure) ?? measures[0];
  const metric = primary?.name ?? "*";
  const aggregation = primary ? ("sum" as const) : ("count" as const);
  const metricLabel = primary ? displayName(primary.name, primary.label) : null;
  const widgets: DashboardWidget[] = [];

  // KPIs: the primary measure, up to three more (more when the goal names them), and always the
  // row count.
  const measureKpis = Math.min(
    MAX_MEASURE_KPIS,
    Math.max(DEFAULT_MEASURE_KPIS, choices.goalMeasures?.length ?? 0),
  );
  if (primary)
    widgets.push({
      id: id(`kpi-${slug(primary.name)}`),
      type: "kpi",
      metric: primary.name,
      aggregation: "sum",
      label: kpiLabel(locale, "sum", metricLabel),
    });
  for (const m of measures.filter((c) => c !== primary).slice(0, measureKpis - 1)) {
    const agg = hintsOf(m.name, m.label).average ? ("avg" as const) : ("sum" as const);
    widgets.push({
      id: id(`kpi-${slug(m.name)}`),
      type: "kpi",
      metric: m.name,
      aggregation: agg,
      label: kpiLabel(locale, agg, displayName(m.name, m.label)),
    });
  }
  widgets.push({
    id: id("kpi-rows"),
    type: "kpi",
    metric: "*",
    aggregation: "count",
    label: rowsLabel(locale),
  });

  const timeColumn = time[0];
  if (choices.includeTrend && timeColumn) {
    const timeBucket = timeBucketFor(timeColumn.span?.days ?? 0);
    widgets.push({
      id: id("trend"),
      type: choices.purpose === "executive" ? "area" : "line",
      title: trendTitle(locale, metricLabel, timeBucket),
      dimension: timeColumn.name,
      metric,
      aggregation,
      timeBucket,
    });
  }

  // The dimensions the goal names each get a chart, in the goal's order, before the default ones.
  // Room is kept for the widgets that are always there; what does not fit is left out whole.
  const rankingColumn = named(dimensions, choices.rankingDimension) ?? dimensions[0];
  const charted = new Set<string>();
  const goalCharts: DashboardWidget[] = [];
  for (const name of choices.goalDimensions ?? []) {
    const column = named(dimensions, name);
    if (!column) continue;
    charted.add(column.name);
    // the dimension the default ranking would use stays that ranking, in the goal's place
    const isRanking = choices.includeRanking && column.name === rankingColumn?.name;
    const donut = !isRanking && column.distinct >= 2 && column.distinct <= COMPOSITION_LIMIT;
    const dimLabel = displayName(column.name, column.label);
    goalCharts.push({
      id: id(isRanking ? "ranking" : `by-${slug(column.name)}`),
      type: donut ? "donut" : "hbar",
      title: donut
        ? shareTitle(locale, metricLabel, dimLabel)
        : byTitle(locale, metricLabel, dimLabel),
      dimension: column.name,
      metric,
      aggregation,
      limit: donut ? COMPOSITION_LIMIT : RANKING_LIMIT,
      ...(donut ? { other: true } : {}),
    });
  }
  const defaults: DashboardWidget[] = [];

  if (choices.includeRanking && rankingColumn && !charted.has(rankingColumn.name))
    defaults.push({
      id: id("ranking"),
      type: "hbar",
      title: byTitle(locale, metricLabel, displayName(rankingColumn.name, rankingColumn.label)),
      dimension: rankingColumn.name,
      metric,
      aggregation,
      limit: RANKING_LIMIT,
    });

  const compositionColumn =
    named(compositionDims, choices.compositionDimension) ?? compositionDims[0];
  if (choices.includeComposition && compositionColumn && !charted.has(compositionColumn.name)) {
    const title = shareTitle(
      locale,
      metricLabel,
      displayName(compositionColumn.name, compositionColumn.label),
    );
    const donut = compositionColumn.distinct <= COMPOSITION_LIMIT;
    defaults.push({
      id: id("composition"),
      type: donut ? "donut" : "hbar",
      title,
      dimension: compositionColumn.name,
      metric,
      aggregation,
      limit: donut ? COMPOSITION_LIMIT : COMPOSITION_BARS,
      other: true,
    });
  }

  // y is the primary measure, x the best other one
  const scatterX = measures.find((m) => m !== primary);
  const correlation: DashboardWidget[] =
    choices.includeCorrelation && primary && scatterX
      ? [
          {
            id: id("correlation"),
            type: "scatter",
            title: scatterTitle(
              locale,
              displayName(primary.name, primary.label),
              displayName(scatterX.name, scatterX.label),
            ),
            x: scatterX.name,
            y: primary.name,
          },
        ]
      : [];

  const table: DashboardWidget[] = [];
  if (choices.purpose !== "executive") {
    const columns = tableColumns(candidates);
    if (columns.length > 0)
      table.push({
        id: id("table"),
        type: "table",
        title: tableTitle(locale),
        columns,
        limit: TABLE_ROWS,
      });
  }

  // The goal's charts come first and the tail is what does not fit in the widget limit.
  const room = Math.max(0, SPEC_LIMITS.widgets - widgets.length - table.length);
  widgets.push(...[...goalCharts, ...defaults, ...correlation].slice(0, room), ...table);

  const layout = PURPOSE_LAYOUT[choices.purpose];
  const ordered = widgets
    .map((widget, index) => ({ widget, index }))
    .sort(
      (a, b) => priorityOf(layout, a.widget) - priorityOf(layout, b.widget) || a.index - b.index,
    )
    .map((entry) => entry.widget);
  return {
    version: 1,
    title: clip(input.title, SPEC_LIMITS.title),
    purpose: choices.purpose,
    layout,
    locale,
    ...(input.sheet ? { sheet: input.sheet } : {}),
    widgets: ordered.slice(0, SPEC_LIMITS.widgets),
  };
}

// ---- the planner ----

export interface PlanInput {
  sheet: SheetDetail;
  goal: string;
  title?: string;
  locale: DashboardLocale;
  /** The consumer side of Decision Intelligence; absent or `null` means rules only. */
  decisions?: Pick<ToolDecisions, "tryDecide"> | null;
  signal?: AbortSignal;
}

export type PlanResult =
  | {
      ok: true;
      spec: DashboardSpec;
      planner: "rules" | "rules+decisions";
      /** Id of the provider whose answers shaped the plan. */
      decisionProvider?: string;
      /** Human-readable notes (metadata only): rejected answers, validator repairs. */
      fallbacks: string[];
      choices: PlanChoices;
      /** Every column of the sheet, profiled: the query planner's catalog. */
      catalog: ProfiledColumn[];
      candidates: Candidates;
    }
  | { ok: false; error: "no_usable_columns" | "plan_failed"; reasons: string[] };

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (error instanceof Error && error.name === "AbortError");

export class RuleBasedPlanner {
  async plan(input: PlanInput): Promise<PlanResult> {
    const { sheet, goal, locale, signal } = input;
    const catalog = profileSheet(sheet);
    const shortlists = buildCandidates(catalog);
    if (shortlists.measures.length + shortlists.dimensions.length + shortlists.time.length === 0)
      return {
        ok: false,
        error: "no_usable_columns",
        reasons: ["no measure, dimension or time column"],
      };

    const fallbacks: string[] = [];
    const pack = buildPack({ goal, locale, candidates: shortlists });
    // the columns the goal names join the shortlists the rules plan from (never the pack's)
    const candidates = withGoalColumns(shortlists, goalColumns(goal, catalog));
    let overrides: Partial<PlanChoices> = {};
    let response: DecisionResponse | null = null;
    if (pack.request && input.decisions) {
      try {
        response = await input.decisions.tryDecide(pack.request, signal ? { signal } : undefined);
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        fallbacks.push("decisions: request failed, rules used");
      }
      if (response) {
        overrides = pack.interpret(response);
        const rejected = Object.keys(response.rejected ?? {});
        if (rejected.length > 0) fallbacks.push(`decisions: rejected ${rejected.join(", ")}`);
        if (Object.keys(overrides).length === 0)
          fallbacks.push("decisions: no usable answer, rules used");
      } else if (fallbacks.length === 0) fallbacks.push("decisions: no usable answer, rules used");
    }

    const tableName = sheet.table !== "data" ? sheet.table : undefined;
    const build = (choices: PlanChoices): DashboardSpec =>
      planDashboard({
        title: input.title?.trim() ? input.title : defaultTitle(locale, choices.purpose),
        locale,
        choices,
        candidates,
        ...(tableName ? { sheet: tableName } : {}),
      });

    const used = Object.keys(overrides).length > 0;
    const ruleChoices = ruleBasedChoices({ goal, candidates, catalog });
    const choices = used ? ruleBasedChoices({ goal, candidates, catalog, overrides }) : ruleChoices;
    let validation = validateSpec(build(choices), catalog);
    let finalChoices = choices;
    let withDecisions = used;
    if (validation.result === "fallback" && used) {
      fallbacks.push(
        `decisions: plan rejected by the validator (${validation.reasons.join("; ")}), rules used`,
      );
      finalChoices = ruleChoices;
      withDecisions = false;
      validation = validateSpec(build(ruleChoices), catalog);
    }
    if (validation.result === "fallback")
      return { ok: false, error: "plan_failed", reasons: validation.reasons };
    if (validation.result === "repaired")
      fallbacks.push(...validation.repairs.map((r) => `repaired: ${r}`));

    return {
      ok: true,
      spec: validation.spec,
      planner: withDecisions ? "rules+decisions" : "rules",
      ...(withDecisions && response ? { decisionProvider: response.provider } : {}),
      fallbacks,
      choices: finalChoices,
      catalog,
      candidates,
    };
  }
}
