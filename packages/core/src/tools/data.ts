/**
 * `data_inspect` and `data_query` (effect `read`, spec §12 and §17): describe and query tabular
 * files (CSV, TSV, JSON, JSONL, XLSX) through one SQLite file per dataset. Ingestion writes only
 * under the state folder, never the repository; the XLSX helper is fixed Alisio code (decision
 * D7), so both keep the `read` effect and work under `--read-only`. They need no Python except
 * for XLSX.
 */
import type { ToolContext, ToolResult, UiBlock } from "@alisio/sdk";
import {
  DataError,
  type DatasetRecord,
  type DatasetService,
  PageParamError,
} from "../analysis/data/datasets.ts";
import { cellText, formatCount } from "../analysis/data/describe.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { safePath } from "../runtime/paths.ts";
import { objectSchema } from "./standard.ts";

export interface DataToolDeps {
  /** `analysis.smartDashboard`: the descriptions also point to `dashboard_generate`. */
  smartDashboard?: boolean;
  datasets: DatasetService;
  rootOf: (sessionId: string) => string;
}

const INSPECT_TEXT_CHARS = 12_000;
const QUERY_TEXT_CHARS = 24_000;

/** A model-readable failure: `code: message` (the codes of §14.1 are also tool error prefixes). */
function failure(error: unknown): never {
  if (error instanceof DataError) throw new Error(`${error.code}: ${error.message}`);
  if (error instanceof PageParamError) throw new Error(`invalid_request: ${error.message}`);
  throw error;
}

function tableBlock(
  columns: string[],
  rows: Array<Array<string | number | null>>,
  caption?: string,
): UiBlock {
  return {
    kind: "table",
    columns,
    rows: rows.map((row) => columns.map((_, i) => cellText(row[i], 120))),
    ...(caption ? { caption } : {}),
  };
}

export function registerDataTools(registry: ToolRegistry, deps: DataToolDeps): void {
  const own = (context: ToolContext) => deps.rootOf(context.session ?? "");

  registry.register({
    name: "data_inspect",
    effect: "read",
    description:
      "Describe a tabular file: sheets, columns with type hints and statistics (nulls, distinct, " +
      "min/max/mean, top values) and sample rows. Pass a workspace file `path` (CSV, TSV, JSON, " +
      "JSONL or XLSX; ingested once into a SQLite dataset of this session) or the `datasetId` of " +
      "a dataset the user attached. The result gives the datasetId to use with data_query and " +
      `python_run { inputs: [{ datasetId }] }${deps.smartDashboard ? " or dashboard_generate { datasetId }" : ""}. XLSX needs Python 3.10+; for the other formats no ` +
      "Python is needed.",
    inputSchema: objectSchema({
      path: { type: "string", minLength: 1, maxLength: 1024 },
      datasetId: { type: "string", minLength: 1, maxLength: 64 },
      sheet: { type: "string", maxLength: 200 },
      sampleRows: { type: "integer", minimum: 0, maximum: 20 },
    }),
    paths: (input) => (typeof input.path === "string" ? [input.path] : []),
    async execute(input, context): Promise<ToolResult> {
      const hasPath = typeof input.path === "string" && input.path !== "";
      const hasId = typeof input.datasetId === "string" && input.datasetId !== "";
      if (hasPath === hasId) throw new Error("Pass exactly one of path or datasetId");
      const root = own(context);
      try {
        let record: DatasetRecord;
        let note = "";
        if (hasId) record = deps.datasets.getFor(String(input.datasetId), root);
        else {
          const resolved = context.resolvePath
            ? await context.resolvePath(String(input.path))
            : await safePath(context.workspace, String(input.path));
          let last = 0;
          const result = await deps.datasets.ingest({
            rootSessionId: root,
            sessionId: context.session ?? "headless",
            workspace: context.workspace,
            path: resolved,
            sourcePath: resolved,
            signal: context.signal,
            onProgress: (rows) => {
              const now = Date.now();
              if (now - last < 1000) return;
              last = now;
              context.emit(`reading ${formatCount(rows)} rows…\n`);
            },
          });
          record = result.record;
          note = result.reused ? "(already ingested in this session)\n" : "";
        }
        const sample = Number(input.sampleRows ?? 5);
        const described = await deps.datasets.describe(
          record,
          sample,
          INSPECT_TEXT_CHARS,
          context.signal,
        );
        const wantedSheet = typeof input.sheet === "string" ? input.sheet : undefined;
        const shown = wantedSheet
          ? described.detail.sheetDetails.filter(
              (s) => s.name === wantedSheet || s.table === wantedSheet,
            )
          : described.detail.sheetDetails;
        if (wantedSheet && !shown.length)
          throw new Error(
            `Sheet ${wantedSheet} not found; sheets: ${described.detail.sheetDetails.map((s) => s.name).join(", ")}`,
          );
        const blocks: UiBlock[] = [];
        for (const sheet of shown.slice(0, 5)) {
          blocks.push(
            tableBlock(
              ["column", "type", "nulls", "distinct", "min", "max", "mean"],
              sheet.columns.map((c) => [
                c.name,
                c.type,
                formatCount(c.nulls),
                `${formatCount(c.distinct)}${c.distinctExact ? "" : "~"}`,
                c.min ?? "",
                c.max ?? "",
                c.mean !== undefined ? Number(c.mean.toPrecision(6)) : "",
              ]),
              `${sheet.table} · ${formatCount(sheet.rows)} rows`,
            ),
          );
          const rows = described.samples.get(sheet.table);
          if (rows?.rows.length)
            blocks.push(
              tableBlock(
                rows.columns,
                rows.rows,
                `${sheet.table} · first ${rows.rows.length} rows`,
              ),
            );
        }
        return {
          content: [
            { type: "text", text: `${note}${described.text}` },
            ...blocks.map((block) => ({ type: "ui" as const, block })),
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  registry.register({
    name: "data_query",
    effect: "read",
    description:
      "Run one read-only SQL query (SQLite dialect: a single SELECT or WITH statement) on a " +
      "dataset of this session. Tables: `data` for CSV/TSV/JSON/JSONL, `s_<sheet>` for XLSX; " +
      'quote column names ("revenue"). Values are stored exactly: numbers are numbers, other ' +
      "cells (007, 1,234, N/A) are their original text, so cast or filter before arithmetic. At " +
      "most maxRows (default 200, max 1000) rows; statements longer than the time limit are " +
      `stopped. Heavy analysis belongs in python_run.${deps.smartDashboard ? " A dashboard of a dataset: dashboard_generate." : ""}`,
    inputSchema: objectSchema(
      {
        datasetId: { type: "string", minLength: 1, maxLength: 64 },
        sql: { type: "string", minLength: 1, maxLength: 20_000 },
        maxRows: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["datasetId", "sql"],
    ),
    async execute(input, context): Promise<ToolResult> {
      try {
        const record = deps.datasets.getFor(String(input.datasetId), own(context));
        const maxRows = Number(input.maxRows ?? 200);
        const result = await deps.datasets.query(record, String(input.sql), {
          maxRows,
          signal: context.signal,
        });
        const lines = [
          result.columns.join("\t"),
          ...result.rows.map((row) => row.map((v) => cellText(v, 2048)).join("\t")),
        ];
        let text = lines.join("\n");
        let cut = false;
        if (text.length > QUERY_TEXT_CHARS) {
          text = `${text.slice(0, QUERY_TEXT_CHARS)}…`;
          cut = true;
        }
        const summary = `${formatCount(result.rows.length)} row${result.rows.length === 1 ? "" : "s"}${
          result.truncated
            ? ` (truncated at maxRows ${maxRows}; add LIMIT/OFFSET or aggregate)`
            : ""
        }${result.clipped ? "; long cells were shortened" : ""}${cut ? "; output shortened" : ""}`;
        return {
          content: [
            { type: "text", text: `${text}\n[${summary}]` },
            {
              type: "ui",
              block: tableBlock(result.columns, result.rows, `${record.name} · ${summary}`),
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
}
