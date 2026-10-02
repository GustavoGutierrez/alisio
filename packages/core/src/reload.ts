/**
 * `/reload`: validate everything BEFORE applying, so a broken configuration leaves the running
 * session untouched. The orchestrator is surface-agnostic: the TUI and the web server pass their
 * own `create`/`swap`/`busy`; core only decides the order and builds the report.
 *
 * Order (nothing is changed until step 4):
 *   1. `busy()` refuses while a turn (or any child work) runs;
 *   2. `validate()` parses the configuration layers;
 *   3. `create()` builds the NEW application next to the current one;
 *   4. `swap(next, previous)` installs it, then the previous one is closed.
 */
import { createHash } from "node:crypto";
import type { ReloadArea, ReloadAreaReport, ReloadReport } from "@alisio/sdk";
import { agentCatalogFromState } from "./agents/active.ts";
import type { AppOptions } from "./application.ts";
import { loadConfigWithProvenance } from "./config.ts";
import { findWorkspace } from "./runtime/paths.ts";

/** What a reload needs to read from an application: a structural subset of `createApplication`. */
export interface ReloadableApp {
  config: object;
  skillCatalog(): Array<{ id: string; enabled: boolean; effective: boolean; description?: string }>;
  prompts: {
    templates: ReadonlyMap<string, unknown>;
    diagnostics: ReadonlyArray<unknown>;
  };
  mcp: { list(): Array<{ name: string }> };
  pluginCatalog(): Array<{
    id: string;
    version?: string;
    builtin: boolean;
    status: string;
    enabled: boolean;
    diagnostic?: string;
  }>;
  plugins: { pluginState?(plugin: string, key: string): unknown };
  close(): Promise<void>;
}

/** A reload that was refused before anything changed (a turn is running, children are active…). */
export class ReloadRefusedError extends Error {
  readonly code = "reload_refused";
  constructor(reason: string) {
    super(reason);
    this.name = "ReloadRefusedError";
  }
}

/** A reload that failed before the swap: the current application is untouched. */
export class ReloadFailedError extends Error {
  readonly code = "reload_failed";
  constructor(
    readonly stage: "config" | "build" | "swap",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReloadFailedError";
  }
}

const hash = (value: unknown): string =>
  createHash("sha1")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 12);

/** `id → signature` per area, so a reload can tell what appeared, disappeared or changed. */
export type ReloadSnapshot = Record<ReloadArea, Record<string, string>>;

/** A comparable view of an application's reloadable state (no values leave this function). */
export function snapshotApplication(app: ReloadableApp): ReloadSnapshot {
  const record = (entries: Array<[string, unknown]>) =>
    Object.fromEntries(entries.map(([id, value]) => [id, hash(value)]));
  let agentState: unknown;
  try {
    agentState = app.plugins.pluginState?.("subagents", "mainAgents");
  } catch {
    /* agent contributions are best-effort */
  }
  const config = app.config as Record<string, unknown>;
  const mcpServers = ((config.mcp as { servers?: Record<string, unknown> } | undefined)?.servers ??
    {}) as Record<string, unknown>;
  return {
    config: record(Object.entries(config)),
    agents: record(agentCatalogFromState(agentState).map((agent) => [agent.id, agent])),
    skills: record(
      app
        .skillCatalog()
        .filter((skill) => skill.effective && skill.enabled)
        .map((skill) => [skill.id, skill.description ?? ""]),
    ),
    prompts: record([...app.prompts.templates.entries()]),
    mcp: record(app.mcp.list().map((server) => [server.name, mcpServers[server.name] ?? null])),
    plugins: record(
      app.pluginCatalog().map((plugin) => [
        plugin.id,
        {
          version: plugin.version,
          status: plugin.status,
          enabled: plugin.enabled,
        },
      ]),
    ),
  };
}

const AREAS: ReloadArea[] = ["config", "agents", "skills", "prompts", "mcp", "plugins"];

function areaReport(
  area: ReloadArea,
  before: Record<string, string>,
  after: Record<string, string>,
): ReloadAreaReport {
  const ids = (record: Record<string, string>) => Object.keys(record).sort();
  const added = ids(after).filter((id) => !(id in before));
  const removed = ids(before).filter((id) => !(id in after));
  const changed = ids(after).filter((id) => id in before && before[id] !== after[id]);
  return {
    area,
    before: Object.keys(before).length,
    after: Object.keys(after).length,
    added,
    removed,
    ...(changed.length ? { changed } : {}),
  };
}

/** The report of a finished reload: per-area diff, restart notes and warnings. */
export function buildReloadReport(
  before: ReloadSnapshot,
  after: ReloadSnapshot,
  next: ReloadableApp,
): ReloadReport {
  const external = next
    .pluginCatalog()
    .filter((plugin) => !plugin.builtin && plugin.status === "active")
    .map((plugin) => plugin.id);
  const warnings = [
    ...next.prompts.diagnostics.map((diagnostic) => {
      const d = diagnostic as { type?: unknown; name?: unknown };
      return `Prompt template ${String(d.name ?? "")}: ${String(d.type ?? "diagnostic")}`.replace(
        /: $/,
        "",
      );
    }),
    ...next
      .pluginCatalog()
      .filter((plugin) => plugin.status === "failed")
      .map(
        (plugin) =>
          `Plugin ${plugin.id} failed to activate: ${plugin.diagnostic ?? "see /plugins"}`,
      ),
  ];
  return {
    refreshed: AREAS.map((area) => areaReport(area, before[area], after[area])),
    restartRequired: external.length
      ? [
          `Plugin code that was already imported is not reloaded; restart Alisio to pick up source changes of: ${external.join(", ")}.`,
        ]
      : [],
    warnings,
  };
}

const AREA_LABEL: Record<ReloadArea, string> = {
  config: "configuration",
  agents: "agents",
  skills: "skills",
  prompts: "prompt templates",
  mcp: "MCP servers",
  plugins: "plugins",
};

/** Markdown of a report (TUI `info` block and the `output` of the web command). */
export function formatReloadReport(report: ReloadReport): string {
  const line = (item: ReloadAreaReport): string => {
    const parts: string[] = [];
    if (item.area === "config")
      parts.push(
        item.changed?.length || item.added.length || item.removed.length
          ? `reloaded, changed: ${[...(item.changed ?? []), ...item.added, ...item.removed].join(", ")}`
          : "reloaded, no changes",
      );
    else {
      parts.push(item.before === item.after ? `${item.after}` : `${item.before} → ${item.after}`);
      if (item.added.length) parts.push(`added ${item.added.join(", ")}`);
      if (item.removed.length) parts.push(`removed ${item.removed.join(", ")}`);
      if (item.changed?.length) parts.push(`updated ${item.changed.join(", ")}`);
    }
    return `- ${AREA_LABEL[item.area]}: ${parts.join(" · ")}`;
  };
  return [
    "**Reload complete**",
    "",
    ...report.refreshed.map(line),
    "",
    "**Needs a restart**",
    "",
    ...(report.restartRequired.length ? report.restartRequired.map((text) => `- ${text}`) : []),
    "- Launch flags (--allow-write, --read-only, --model…) keep their startup values.",
    ...(report.warnings.length
      ? ["", "**Warnings**", "", ...report.warnings.map((text) => `- ${text}`)]
      : []),
  ].join("\n");
}

/**
 * Parses the configuration layers exactly as `createApplication` would, with no side effects.
 * Throws `ReloadFailedError("config")` when a layer is malformed.
 */
export async function validateReloadConfig(options: AppOptions): Promise<void> {
  try {
    const workspace = await findWorkspace(options.cwd ?? process.cwd());
    await loadConfigWithProvenance(workspace, {
      file: options.config,
      trustProject: options.trustProject,
      model: options.model,
      baseURL: options.baseURL,
      apiMode: options.apiMode,
    });
  } catch (error) {
    throw new ReloadFailedError("config", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

export interface ReloadInput<A extends ReloadableApp> {
  current: A;
  /** A reason to refuse (a turn runs, a child agent is active…), or undefined when idle. */
  busy?: () => string | undefined | Promise<string | undefined>;
  /** Cheap, side-effect-free checks run before anything is built. */
  validate?: () => Promise<void>;
  /** Builds the new application. The current one keeps running until `swap` succeeds. */
  create: () => Promise<A>;
  /** Installs `next` in place of `previous` (rebind the surface). Must not close `previous`. */
  swap: (next: A, previous: A) => void | Promise<void>;
}

/**
 * Runs a validated reload and returns its report. Throws `ReloadRefusedError` or
 * `ReloadFailedError`; in every failure the current application is still the active one.
 */
export async function reloadApplication<A extends ReloadableApp>(
  input: ReloadInput<A>,
): Promise<ReloadReport> {
  const reason = await input.busy?.();
  if (reason) throw new ReloadRefusedError(reason);
  await input.validate?.();
  let next: A;
  try {
    next = await input.create();
  } catch (error) {
    throw new ReloadFailedError("build", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  let report: ReloadReport;
  try {
    report = buildReloadReport(snapshotApplication(input.current), snapshotApplication(next), next);
    await input.swap(next, input.current);
  } catch (error) {
    await next.close().catch(() => undefined);
    throw new ReloadFailedError("swap", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  await input.current.close().catch(() => undefined);
  return report;
}
