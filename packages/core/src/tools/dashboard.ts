/**
 * `dashboard_generate` (effect `internal`, like `artifact_create`): a dataset of this session to a
 * published dashboard artifact with no code and no model call. Profile, plan (rules first, the
 * decision provider on top), validate, query, render and publish; the pure steps live in
 * `analysis/dashboard/`. It reads one dataset of the session and writes to Alisio's artifact
 * store, nothing else: no process, no network, no workspace file.
 */
import {
  type DashboardLocale,
  type DashboardProvenance,
  type DashboardSpec,
  type ToolContext,
  type ToolResult,
} from "@alisio/sdk";
import {
  DashboardQueryError,
  GOAL_LIMITS,
  goalColumns,
  LOCALES,
  queryDashboard,
  RuleBasedPlanner,
  renderDashboard,
  roleOfWidget,
} from "../analysis/dashboard/index.ts";
import { DataError, type DatasetService } from "../analysis/data/datasets.ts";
import { ArtifactRejected } from "../artifacts/store.ts";
import type { CoreArtifactPublisher } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { artifactBlocks, describeArtifact } from "./artifact-blocks.ts";
import { objectSchema } from "./standard.ts";

export interface DashboardToolDeps {
  datasets: DatasetService;
  rootOf: (sessionId: string) => string;
}

export const DASHBOARD_FILE_NAME = "dashboard.html";

/** Largest goal the schema lets through; the planner reads the first 2000 characters of it. */
const GOAL_INPUT_GUARD = 20_000;

/** System-prompt rule added only while `analysis.smartDashboard` is on (spec §10.1). */
export const DASHBOARD_PROMPT_RULE =
  "When the user asks for a dashboard (or KPIs and charts) of a dataset, call dashboard_generate first with the dataset id and the user's goal. Use python_run only if dashboard_generate returns an error or the request needs something its catalog does not cover (statistical tests, custom charts, joins, exports).";

/** Shown to the model when the catalog cannot cover a dataset or a request. */
const USE_PYTHON = "Use python_run to build this visual instead.";

const DESCRIPTION =
  "Use this first whenever the user asks for a dashboard of a dataset. Build a ready-made dashboard (KPIs, trend, ranking, composition, correlation, table) from a " +
  "dataset of this session and publish it as an HTML artifact, with no code. The charts and " +
  "titles are chosen from the dataset's columns by fixed rules; the numbers come from queries " +
  "on the dataset. Optional: goal (what the dashboard is for; name the columns you want to see, " +
  "they are charted; up to 2000 characters), title, " +
  "locale (en or es, default en) and sheet (a sheet of a spreadsheet; default the first). Call " +
  "it again with another goal to regenerate. For analysis or visuals this catalog does not " +
  "cover (statistical tests, custom charts, joins, exports), use python_run.";

const COUNT_LABELS: Record<
  DashboardLocale,
  {
    created: string;
    kpi: [string, string];
    chart: [string, string];
    ranking: [string, string];
    table: [string, string];
    published: string;
    components: string;
    notes: string;
    status: string;
    done: string;
    measures: string;
    dimensions: string;
    notShown: string;
    notShownHint: string;
  }
> = {
  en: {
    created: "Dashboard created",
    kpi: ["KPI", "KPIs"],
    chart: ["chart", "charts"],
    ranking: ["ranking", "rankings"],
    table: ["table", "tables"],
    published: "Published",
    components: "Components",
    notes: "Notes",
    status: "Status",
    done: "The dashboard is complete and already published. Next step: give the user a short summary of it. To change it, call dashboard_generate again with another goal; do not rebuild it with python_run.",
    measures: "Measures",
    dimensions: "Dimensions",
    notShown: "Not shown",
    notShownHint:
      "columns your goal names that this dashboard does not use; say so in your summary and offer a follow-up. Use python_run only for what the user explicitly asked for beyond this.",
  },
  es: {
    created: "Dashboard creado",
    kpi: ["KPI", "KPI"],
    chart: ["gráfico", "gráficos"],
    ranking: ["ranking", "rankings"],
    table: ["tabla", "tablas"],
    published: "Publicado",
    components: "Componentes",
    notes: "Notas",
    status: "Estado",
    done: "El dashboard está completo y ya publicado. Siguiente paso: dar al usuario un resumen breve. Para cambiarlo, llama a dashboard_generate de nuevo con otro objetivo; no lo reconstruyas con python_run.",
    measures: "Medidas",
    dimensions: "Dimensiones",
    notShown: "No mostradas",
    notShownHint:
      "columnas que tu objetivo nombra y este dashboard no usa; dilo en tu resumen y ofrece un seguimiento. Usa python_run solo para lo que el usuario pidió expresamente además de esto.",
  },
};

/** A model-readable failure: `code: message`. Cancellation and unknown errors pass through. */
function failure(error: unknown): never {
  if (error instanceof DataError) {
    const code = error.code === "not_found" ? "dataset_not_found" : error.code;
    throw new Error(`${code}: ${error.message}`);
  }
  throw error;
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

function publisherOf(context: ToolContext): CoreArtifactPublisher {
  const publisher = context.artifacts as CoreArtifactPublisher | undefined;
  if (!publisher || typeof publisher.publishTextDetailed !== "function")
    throw new Error("Artifacts are not available here (no artifact store for this session)");
  return publisher;
}

/** `4 KPIs · 3 charts · 1 ranking`: zero counts are left out. */
function countsLine(spec: DashboardSpec, shown: ReadonlySet<string>, locale: DashboardLocale) {
  const labels = COUNT_LABELS[locale];
  const counts = { kpi: 0, chart: 0, ranking: 0, table: 0 };
  for (const widget of spec.widgets) {
    if (!shown.has(widget.id)) continue;
    const role = roleOfWidget(widget);
    if (role === "kpi") counts.kpi++;
    else if (role === "ranking") counts.ranking++;
    else if (role === "table") counts.table++;
    else counts.chart++;
  }
  return (["kpi", "chart", "ranking", "table"] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${labels[key][counts[key] === 1 ? 0 : 1]}`)
    .join(" · ");
}

/** Columns the widgets read: measures (aggregated or plotted) and dimensions (grouped or listed). */
function columnsUsed(spec: DashboardSpec, shown: ReadonlySet<string>) {
  const measures = new Set<string>();
  const dimensions = new Set<string>();
  for (const w of spec.widgets) {
    if (!shown.has(w.id)) continue;
    if (w.type === "kpi") {
      if (w.metric !== "*") measures.add(w.metric);
    } else if (w.type === "scatter") {
      measures.add(w.x);
      measures.add(w.y);
    } else if (w.type === "table") {
      for (const column of w.columns) dimensions.add(column);
    } else {
      if (w.metric !== "*") measures.add(w.metric);
      dimensions.add(w.dimension);
    }
  }
  return { measures, dimensions };
}

/** Notes meant for the model: provider bookkeeping stays in the provenance. */
const modelNotes = (fallbacks: readonly string[]) =>
  fallbacks.filter((note) => !note.startsWith("decisions:"));

export function registerDashboardTools(registry: ToolRegistry, deps: DashboardToolDeps): void {
  const planner = new RuleBasedPlanner();

  registry.register({
    name: "dashboard_generate",
    effect: "internal",
    description: DESCRIPTION,
    inputSchema: objectSchema(
      {
        datasetId: { type: "string", minLength: 1, maxLength: 64 },
        // longer text is truncated with a note, never rejected (the schema bound is only a guard)
        goal: { type: "string", maxLength: GOAL_INPUT_GUARD },
        title: { type: "string", maxLength: 120 },
        locale: { type: "string", enum: [...LOCALES] },
        sheet: { type: "string", maxLength: 200 },
      },
      ["datasetId"],
    ),
    async execute(input, context): Promise<ToolResult> {
      const publisher = publisherOf(context);
      const { signal } = context;
      const throwIfCancelled = () => {
        if (signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      };
      const emit = (line: string) => context.emit(`${line}\n`);
      const locale: DashboardLocale = input.locale === "es" ? "es" : "en";
      const fullGoal = typeof input.goal === "string" ? input.goal : "";
      const goal = fullGoal.slice(0, GOAL_LIMITS.match);
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "";
      throwIfCancelled();

      emit("Analyzing dataset…");
      let record: ReturnType<DatasetService["getFor"]>;
      let sheet: ReturnType<DatasetService["detail"]>["sheetDetails"][number];
      try {
        record = deps.datasets.getFor(String(input.datasetId), deps.rootOf(context.session ?? ""));
        const detail = deps.datasets.detail(record);
        const wanted = typeof input.sheet === "string" && input.sheet ? input.sheet : undefined;
        const found = wanted
          ? detail.sheetDetails.find((s) => s.name === wanted || s.table === wanted)
          : detail.sheetDetails[0];
        if (!found)
          throw new Error(
            wanted
              ? `invalid_request: Unknown sheet "${wanted}". Sheets: ${detail.sheetDetails.map((s) => s.name).join(", ")}`
              : "invalid_request: The dataset has no sheet",
          );
        sheet = found;
      } catch (error) {
        return failure(error);
      }
      throwIfCancelled();

      emit("Planning dashboard…");
      const plan = await planner.plan({
        sheet,
        goal,
        locale,
        ...(title ? { title } : {}),
        ...(context.decisions ? { decisions: context.decisions } : {}),
        signal,
      });
      if (!plan.ok)
        throw new Error(
          plan.error === "no_usable_columns"
            ? `no_usable_columns: The dataset has no measure, dimension or time column a dashboard can use. ${USE_PYTHON}`
            : `plan_failed: No valid dashboard could be planned (${plan.reasons.join("; ")}). ${USE_PYTHON}`,
        );
      throwIfCancelled();

      emit(`Building ${plan.spec.widgets.length} components…`);
      let run: Awaited<ReturnType<typeof queryDashboard>>;
      try {
        run = await queryDashboard({
          spec: plan.spec,
          catalog: plan.catalog,
          rows: sheet.rows,
          signal,
          run: (sql, maxRows) => deps.datasets.query(record, sql, { maxRows, signal }),
          onProgress: (done, total) => emit(`Query ${done}/${total}…`),
        });
      } catch (error) {
        if (error instanceof DashboardQueryError)
          throw new Error(
            `query_failed: ${error.message}${error.fallbacks.length ? ` (${error.fallbacks.join("; ")})` : ""}. ${USE_PYTHON}`,
          );
        if (isAbort(error)) throw error;
        return failure(error);
      }
      throwIfCancelled();

      const html = renderDashboard(plan.spec, run.data);
      const fallbacks = [...plan.fallbacks, ...run.fallbacks];
      const provenance: DashboardProvenance = {
        generator: "dashboard_generate",
        spec: plan.spec,
        planner: plan.planner,
        ...(plan.decisionProvider ? { decisionProvider: plan.decisionProvider } : {}),
        fallbacks,
      };
      let published: Awaited<ReturnType<CoreArtifactPublisher["publishTextDetailed"]>>;
      try {
        published = await publisher.publishTextDetailed({
          fileName: DASHBOARD_FILE_NAME,
          title: plan.spec.title,
          text: html,
          provenance: { ...provenance },
        });
      } catch (error) {
        if (error instanceof ArtifactRejected)
          throw new Error(`Publication rejected: ${error.message}`);
        throw error;
      }
      emit("Dashboard ready");

      const labels = COUNT_LABELS[locale];
      const shown = new Set(run.data.map((d) => d.id));
      const widgets = plan.spec.widgets.filter((w) => shown.has(w.id));
      const used = columnsUsed(plan.spec, shown);
      const unused = goalColumns(goal, plan.catalog)
        .map((match) => match.column.name)
        .filter((name) => !used.measures.has(name) && !used.dimensions.has(name));
      const notes = [
        ...modelNotes(fallbacks),
        ...(fullGoal.length > goal.length
          ? [`goal truncated to its first ${GOAL_LIMITS.match} characters`]
          : []),
      ];
      const lines = [
        `${labels.created}: ${plan.spec.title} — ${countsLine(plan.spec, shown, locale)}`,
        `${labels.published} ${describeArtifact(published)}`,
        `${labels.components}:`,
        ...widgets.map((w) => `- ${(w.type === "kpi" ? w.label : w.title) || w.id} (${w.type})`),
        ...(used.measures.size ? [`${labels.measures}: ${[...used.measures].join(", ")}`] : []),
        ...(used.dimensions.size
          ? [`${labels.dimensions}: ${[...used.dimensions].join(", ")}`]
          : []),
        ...(unused.length
          ? [`${labels.notShown}: ${unused.join(", ")} (${labels.notShownHint})`]
          : []),
        ...(notes.length ? [`${labels.notes}: ${notes.join("; ")}`] : []),
        `${labels.status}: ${labels.done}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }, ...artifactBlocks([published])],
      };
    },
  });
}
