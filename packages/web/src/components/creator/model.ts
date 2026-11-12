/**
 * Pure logic of the plugin creator page (no DOM, tested in Node): status badges, the step list,
 * request checks, failure classification, the file tree, the schema diagram layout and the share
 * commands. Components stay thin around these functions.
 */
import type {
  PluginCreatorBuildResponse,
  PluginCreatorIssue,
  PluginCreatorProjectEntry,
  PluginCreatorSchema,
  PluginCreatorStep,
  PluginCreatorStepId,
  SessionUiStatus,
} from "@alisio/sdk";
import { ApiRequestError } from "../../net/api.ts";
import { creatorStrings, type IssueKey } from "./strings.ts";

/** Server limit of a request (`PLUGIN_CREATOR_LIMITS.requestChars`). */
export const REQUEST_MAX = 8_000;
export const STEP_IDS: PluginCreatorStepId[] = ["plan", "tests", "code", "run_tests", "package"];

export type Badge = "building" | "update" | "installed" | "notInstalled";

export function statusBadge(entry: PluginCreatorProjectEntry, running: boolean): Badge {
  if (running) return "building";
  if (entry.status.installed && entry.status.updateAvailable) return "update";
  if (entry.status.installed) return "installed";
  return "notInstalled";
}

/** The version shown on a card: the project's own (the one the next install would ship). */
export const displayVersion = (entry: PluginCreatorProjectEntry): string =>
  entry.project.version || entry.status.projectVersion;

/** The five steps in order; steps the agent has not reported yet are pending. */
export function stepsView(steps: PluginCreatorStep[] | undefined): PluginCreatorStep[] {
  return STEP_IDS.map(
    (id) => steps?.find((step) => step.id === id) ?? { id, status: "pending" as const },
  );
}

/** A creator run is going on: the model works or waits for the person. */
export const isRunActive = (status: SessionUiStatus | undefined): boolean =>
  status === "queued" || status === "running" || status === "awaiting_input";

export function requestProblem(text: string): "empty" | "tooLong" | undefined {
  const value = text.trim();
  if (!value) return "empty";
  if (value.length > REQUEST_MAX) return "tooLong";
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Elapsed time as m:ss for the live timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The localized key of a build finding code, or undefined for codes this client does not know. */
export function issueKey(code: string): IssueKey | undefined {
  return code !== "genericIssue" && code in creatorStrings.issuesEn
    ? (code as IssueKey)
    : undefined;
}

export type CreatorFailure =
  | {
      kind: "tests";
      passed: number;
      failed: number;
      build?: PluginCreatorBuildResponse;
      issues?: undefined;
    }
  | { kind: "invalid"; issues: PluginCreatorIssue[]; build?: PluginCreatorBuildResponse }
  | { kind: "busy" | "readOnly" | "model" | "notFound" | "notBuilt"; issues?: undefined }
  | { kind: "other"; message: string; issues?: undefined };

const isBuild = (value: unknown): value is PluginCreatorBuildResponse =>
  !!value && typeof value === "object" && "build" in value && "issues" in value;

/** Classifies an API failure of the creator routes into what the page explains. */
export function creatorFailure(error: unknown): CreatorFailure {
  if (error instanceof ApiRequestError) {
    const details = error.details;
    if (error.code === "plugin_tests_failed") {
      const build = isBuild(details) ? details : undefined;
      return {
        kind: "tests",
        passed: build?.tests?.passed ?? build?.build.testsPassed ?? 0,
        failed: build?.tests?.failed ?? build?.build.testsFailed ?? 0,
        ...(build ? { build } : {}),
      };
    }
    if (error.code === "plugin_project_invalid") {
      const build = isBuild(details) ? details : undefined;
      return {
        kind: "invalid",
        issues: (build?.issues ?? []).filter((issue) => issue.severity === "error"),
        ...(build ? { build } : {}),
      };
    }
    if (error.code === "plugin_project_busy") return { kind: "busy" };
    if (error.code === "capability_ceiling") return { kind: "readOnly" };
    if (error.code === "plugin_project_not_found") return { kind: "notFound" };
    if (error.code === "plugin_not_built") return { kind: "notBuilt" };
    const fields = (details as { fields?: unknown } | undefined)?.fields;
    if (error.code === "validation_failed" && Array.isArray(fields) && fields.includes("model"))
      return { kind: "model" };
  }
  return { kind: "other", message: error instanceof Error ? error.message : String(error) };
}

export interface FileRow {
  kind: "dir" | "file";
  name: string;
  /** Full project-relative path (folders too). */
  path: string;
  depth: number;
  bytes: number;
}

interface Folder {
  dirs: Map<string, Folder>;
  files: Array<{ name: string; path: string; bytes: number }>;
}

/** Depth-first rows of the project files: folders first, then files, each sorted by name. */
export function fileTree(files: Array<{ path: string; bytes: number }>): FileRow[] {
  const root: Folder = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let folder = root;
    for (const part of parts) {
      let next = folder.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        folder.dirs.set(part, next);
      }
      folder = next;
    }
    folder.files.push({ name, path: file.path, bytes: file.bytes });
  }
  const rows: FileRow[] = [];
  const size = (folder: Folder): number =>
    folder.files.reduce((sum, f) => sum + f.bytes, 0) +
    [...folder.dirs.values()].reduce((sum, d) => sum + size(d), 0);
  const walk = (folder: Folder, depth: number, prefix: string) => {
    for (const name of [...folder.dirs.keys()].sort()) {
      const child = folder.dirs.get(name) as Folder;
      const path = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "dir", name, path, depth, bytes: size(child) });
      walk(child, depth + 1, path);
    }
    for (const file of [...folder.files].sort((a, b) => a.name.localeCompare(b.name)))
      rows.push({ kind: "file", name: file.name, path: file.path, depth, bytes: file.bytes });
  };
  walk(root, 0, "");
  return rows;
}

// ---- Schema diagram ---------------------------------------------------------------------------

/** Control offset of a connector between tables of the same column (into the right margin). */
const LOOP = 44;
export const SCHEMA_BOX = { width: 220, header: 34, row: 24, gapX: 72, gapY: 40, pad: 16 };

export interface SchemaTableBox {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: Array<PluginCreatorSchema["tables"][number]["columns"][number] & { y: number }>;
}

export interface SchemaLink {
  /** `table.column` of the referencing column. */
  from: string;
  /** `table.column` (or just `table`) it points at. */
  to: string;
  /** SVG path data of the connector. */
  path: string;
}

export interface SchemaLayout {
  width: number;
  height: number;
  tables: SchemaTableBox[];
  links: SchemaLink[];
}

/**
 * Lays tables out on a grid (two columns up to four tables, then three) with rows of equal
 * height, and draws a curved connector for each foreign key whose target table exists, from the
 * referencing column's side to the referenced column (or the table header).
 */
export function schemaLayout(schema: PluginCreatorSchema): SchemaLayout {
  const { width, header, row, gapX, gapY, pad } = SCHEMA_BOX;
  const count = schema.tables.length;
  if (!count) return { width: 0, height: 0, tables: [], links: [] };
  const perRow = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const heights = schema.tables.map((t) => header + Math.max(1, t.columns.length) * row + 8);
  const rowHeights: number[] = [];
  heights.forEach((h, i) => {
    const r = Math.floor(i / perRow);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, h);
  });
  const rowTop = (r: number) => pad + rowHeights.slice(0, r).reduce((sum, h) => sum + h + gapY, 0);
  const tables: SchemaTableBox[] = schema.tables.map((table, i) => {
    const x = pad + (i % perRow) * (width + gapX);
    const y = rowTop(Math.floor(i / perRow));
    return {
      name: table.name,
      x,
      y,
      width,
      height: heights[i] ?? header,
      columns: table.columns.map((column, c) => ({ ...column, y: y + header + c * row + row / 2 })),
    };
  });
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const links: SchemaLink[] = [];
  let loops = false;
  for (const source of tables)
    for (const column of source.columns) {
      if (!column.fk) continue;
      const target = byName.get(column.fk.table.toLowerCase());
      if (!target) continue;
      const targetColumn = column.fk.column
        ? target.columns.find((c) => c.name.toLowerCase() === column.fk?.column?.toLowerCase())
        : target.columns.find((c) => c.pk);
      const ty = targetColumn?.y ?? target.y + header / 2;
      // Same column (stacked or the table itself): leave and enter on the right edge, bulging
      // into the right margin. Otherwise connect the facing edges.
      const stacked = Math.abs(target.x - source.x) < width;
      const rightward = target.x > source.x;
      const sx = stacked || rightward ? source.x + width : source.x;
      const tx = stacked ? target.x + width : rightward ? target.x : target.x + width;
      const bend = stacked ? LOOP : Math.max(36, Math.abs(tx - sx) / 2);
      const c1 = stacked || rightward ? sx + bend : sx - bend;
      const c2 = stacked ? tx + bend : rightward ? tx - bend : tx + bend;
      if (stacked) loops = true;
      links.push({
        from: `${source.name}.${column.name}`,
        to: targetColumn ? `${target.name}.${targetColumn.name}` : target.name,
        path: `M${sx} ${column.y} C${c1} ${column.y} ${c2} ${ty} ${tx} ${ty}`,
      });
    }
  const right = Math.max(...tables.map((t) => t.x + t.width));
  const bottom = Math.max(...tables.map((t) => t.y + t.height));
  return {
    // Loops bulge about 3/4 of their control offset past the right edge.
    width: right + pad + (loops ? LOOP : 0),
    height: bottom + pad,
    tables,
    links,
  };
}

// ---- Share ------------------------------------------------------------------------------------

/** The terminal commands of the npm tutorial; the folder is double-quoted for the shell. */
export function shareCommands(dir: string): {
  login: string;
  cd: string;
  publish: string;
  bump: string;
} {
  return {
    login: "npm login",
    cd: `cd "${dir.replace(/"/g, '\\"')}"`,
    publish: "npm publish --access public",
    bump: "npm version patch",
  };
}

/** Text of the "fix these problems" prompt: one bullet per finding, with its file. */
export function fixList(issues: PluginCreatorIssue[]): string {
  return issues
    .map((issue) => `- ${issue.code}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`)
    .join("\n");
}
