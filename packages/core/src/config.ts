import { chmod, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@alisio/sdk";
import { z } from "zod";
import { DEFAULT_DECISIONS_CONFIG } from "./decisions/service.ts";
import { exists, readJson } from "./runtime/fs.ts";
import { isPathSpec } from "./runtime/modules.ts";

const providerSchema = z
  .object({
    baseURL: z.url().default("https://api.openai.com/v1"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    model: z.string().default(""),
    apiMode: z.enum(["chat", "responses"]).default("chat"),
    auth: z.enum(["bearer", "none"]).default("bearer"),
    tokenParameter: z.enum(["max_tokens", "max_completion_tokens", "omit"]).default("max_tokens"),
    streamUsage: z.boolean().default(false),
    /** Context window in tokens; overrides the value reported by GET /models. */
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();
const safeUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    },
    { message: "must be an HTTP(S) URL without credentials" },
  );
const environment = z.record(z.string(), z.string());
const stdioServerSchema = z
  .object({
    transport: z.literal("stdio"),
    enabled: z.boolean().default(true),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    envAllow: z.array(z.string()).default([]),
    env: environment.default({}),
  })
  .strict();
const httpServerSchema = z
  .object({
    transport: z.literal("http"),
    enabled: z.boolean().default(true),
    url: safeUrl,
    bearerTokenEnv: z.string().trim().min(1).optional(),
  })
  .strict();
const serverSchema = z.discriminatedUnion("transport", [stdioServerSchema, httpServerSchema]);
const compatibleServerSchema = z.union([
  serverSchema,
  z
    .object({
      command: z.string().trim().min(1),
      enabled: z.boolean().default(true),
      args: z.array(z.string()).default([]),
      envAllow: z.array(z.string()).default([]),
      env: environment.default({}),
    })
    .strict()
    .transform((server) => ({ ...server, transport: "stdio" as const })),
  z
    .object({
      url: safeUrl,
      enabled: z.boolean().default(true),
      bearerTokenEnv: z.string().trim().min(1).optional(),
    })
    .strict()
    .transform((server) => ({ ...server, transport: "http" as const })),
]);
const serverName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const serversSchema = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).superRefine((servers, context) => {
    for (const name of Object.keys(servers))
      if (!serverName.test(name))
        context.addIssue({
          code: "custom",
          path: [name],
          message: "MCP server names may contain only letters, numbers, dot, underscore and dash",
        });
  });
/**
 * A container image reference pinned by digest. Anchored at the start with a letter or digit so a
 * value can never be read as an option by the container CLI.
 */
export const OCI_IMAGE_PATTERN = /^[a-zA-Z0-9][^\s@]*@sha256:[a-f0-9]{64}$/;
/** Analysis keys only the user (global) layer decides; a project layer cannot set them. */
const GLOBAL_ONLY_ANALYSIS = ["runtime", "oci", "retention"] as const;
/** Decision Intelligence keys only the user (global) layer decides: the provider and telemetry. */
const GLOBAL_ONLY_DECISIONS = ["provider", "telemetry"] as const;
/** JSON values a plugin may receive as options (`pluginOverrides[id].options`). */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const PLUGIN_OPTION_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PLUGIN_OPTIONS_MAX_BYTES = 8 * 1024;
const pluginOptionsSchema = z
  .record(z.string(), jsonValueSchema)
  .superRefine((options, context) => {
    for (const key of Object.keys(options))
      if (!PLUGIN_OPTION_KEY.test(key))
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            "Plugin option names start with a letter and use letters, digits, dot, underscore or dash",
        });
    if (Buffer.byteLength(JSON.stringify(options), "utf8") > PLUGIN_OPTIONS_MAX_BYTES)
      context.addIssue({
        code: "custom",
        message: "Plugin options may not exceed 8 KB serialized",
      });
  });
const configObjectSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    provider: providerSchema.default(() => providerSchema.parse({})),
    plugins: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    /**
     * Extra directories the mediated path policy may touch outside the workspace. Resolved
     * relative to the defining configuration file and canonicalized on load. Additive across
     * layers like `plugins`/`skills`: a lower layer can only ADD, never clear the global list.
     */
    additionalDirectories: z.array(z.string().trim().min(1)).default([]),
    /** Project-local enable/disable overrides for effective non-plugin skills. */
    skillOverrides: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()).default({}),
    mcp: z
      .object({
        servers: serversSchema(compatibleServerSchema).default({}),
        /**
         * Global-only user preference: grants MCP process/network consent across sessions.
         * Only the user (global) configuration layer is consulted; a project value is ignored.
         */
        allow: z.boolean().optional(),
      })
      .strict()
      .default({ servers: {} }),
    /** Compatibility with the common MCP client configuration shape. */
    mcpServers: serversSchema(compatibleServerSchema).optional(),
    /** Built-in plugin options keyed by id; each plugin validates its own section. */
    builtinPlugins: z
      .record(z.string(), z.object({ enabled: z.boolean().optional() }).passthrough())
      .default({}),
    /** Project-local enable/disable overrides for configured external plugins, keyed by plugin id. */
    pluginOverrides: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean().optional(),
            /** Global-only, read-only options handed to the plugin as `api.options` (8 KB). */
            options: pluginOptionsSchema.optional(),
          })
          .strict(),
      )
      .default({}),
    /** Host-enforced timeouts for plugin hooks. */
    pluginHooks: z
      .object({
        timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
        sessionEndTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
        /** Per-plugin limit for `dispose()` (and the active decision provider's `deactivate()`). */
        disposeTimeoutMs: z.number().int().min(100).max(10_000).default(2000),
      })
      .strict()
      .default(() => ({ timeoutMs: 15_000, sessionEndTimeoutMs: 10_000, disposeTimeoutMs: 2000 })),
    /**
     * Decision Intelligence: the active provider is chosen here and only here. `provider` and
     * `telemetry` are global-only (a repository cannot pick the engine or the telemetry policy).
     */
    decisions: z
      .object({
        enabled: z.boolean().default(true),
        provider: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
          .nullable()
          .default(null),
        timeoutMs: z.number().int().min(50).max(10_000).default(DEFAULT_DECISIONS_CONFIG.timeoutMs),
        minConfidence: z.number().min(0).max(1).default(DEFAULT_DECISIONS_CONFIG.minConfidence),
        telemetry: z.boolean().default(true),
      })
      .strict()
      .default(() => ({ ...DEFAULT_DECISIONS_CONFIG })),
    context: z
      .object({
        /** Use CLAUDE.md where a directory has no AGENTS.md (off by default). */
        claudeMdFallback: z.boolean().default(false),
        /** Total bytes of AGENTS.md content injected (closest files kept). */
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .max(1_048_576)
          .default(32 * 1024),
      })
      .strict()
      .default(() => ({ claudeMdFallback: false, maxBytes: 32 * 1024 })),
    compaction: z
      .object({
        auto: z.boolean().default(true),
        threshold: z.number().min(0.1).max(0.99).default(0.85),
        keepTurns: z.number().int().min(0).max(20).default(2),
        /**
         * Output token budget for the summarizer call. Larger than the agent-loop budget on
         * purpose: a truncated summary is kept as partial, never re-run.
         */
        maxOutputTokens: z.number().int().positive().default(16_000),
      })
      .strict()
      .default(() => ({ auto: true, threshold: 0.85, keepTurns: 2, maxOutputTokens: 16_000 })),
    websearch: z
      .object({
        provider: z
          .enum([
            "searxng",
            "duckduckgo-instant",
            "duckduckgo-html",
            "tavily",
            "brave",
            "serpapi",
            "native",
          ])
          .optional(),
        searxngUrl: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        /** Only for provider "native": the provider-native tool type sent to the model. */
        nativeToolType: z.string().default("web_search"),
      })
      .strict()
      .default(() => ({ nativeToolType: "web_search" })),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(100).default(100),
        timeoutMs: z.number().int().min(100).default(600000),
        /**
         * Stop a model request that stays completely silent (no text, reasoning or tool-call
         * delta) this long, so a queued or stuck provider is cut after 90 s instead of the
         * whole-run `timeoutMs`. 0 disables it (models that do not stream their reasoning can stay
         * silent for minutes: raise or disable it for those).
         */
        firstTokenTimeoutMs: z.number().int().min(0).default(90000),
        /**
         * How many times the SAME request is sent again after it stayed silent for
         * `firstTokenTimeoutMs` (a stalled connection usually answers on the next try). 0
         * disables the retry. Never counts as a turn.
         */
        firstTokenRetries: z.number().int().min(0).max(3).default(1),
        /**
         * How many times a turn is requested again after the model's response was cut off by
         * `maxOutputTokens` before it was usable (no text and no tool call, or a tool call with
         * incomplete arguments). The truncated calls are never executed. 0 disables the
         * recovery. Never counts as a turn.
         */
        truncationRecoveries: z.number().int().min(0).max(5).default(2),
        maxContextChars: z.number().int().positive().default(800000),
        /**
         * Per-call output token budget for one agent turn. Deliberately WITHOUT a schema default:
         * when unset, the budget of each request is the model catalog's declared maximum (capped
         * at 65536) or 16384 (see `core/output-limit.ts`), so "set by the user" stays
         * distinguishable from "defaulted". A value set here always wins. 4096 starves
         * reasoning-heavy models, which can spend the whole budget on `reasoning_content`
         * before any usable text arrives.
         */
        maxOutputTokens: z.number().int().positive().optional(),
        /** Cumulative tokens per run; default is proportional to the context window. */
        maxTokens: z.number().int().positive().optional(),
      })
      .default(() => ({
        maxTurns: 100,
        timeoutMs: 600000,
        firstTokenTimeoutMs: 90000,
        firstTokenRetries: 1,
        truncationRecoveries: 2,
        maxContextChars: 800000,
      })),
    /**
     * Python analysis and downloadable artifacts. `enabled: false` registers none of the
     * analysis tools. The interpreter is discovered automatically (or pinned with `--python`).
     */
    analysis: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Where `python_run` executes. `managed` is the discovered Python (not a sandbox); `oci`
         * is a Docker or Podman container started from a pinned image. GLOBAL ONLY: a project
         * layer cannot choose the runtime or the image (it is ignored with a diagnostic).
         */
        runtime: z.enum(["managed", "oci"]).default("managed"),
        /** Container runtime settings (global only). Used when `runtime` is `oci`. */
        oci: z
          .object({
            engine: z.enum(["docker", "podman"]).default("docker"),
            /** `name@sha256:<digest>`: an image without a digest is rejected at load time. */
            image: z
              .string()
              .regex(
                OCI_IMAGE_PATTERN,
                "analysis.oci.image must be pinned by digest: <name>@sha256:<64 hex characters>",
              )
              .optional(),
            memoryMb: z.number().int().min(256).max(65_536).default(2048),
            cpus: z.number().min(0.5).max(64).default(2),
          })
          .strict()
          .default(() => ({ engine: "docker" as const, memoryMb: 2048, cpus: 2 })),
        limits: z
          .object({
            /** Default and maximum run time of one python_run call. */
            timeoutMs: z.number().int().min(1000).max(900_000).default(120_000),
            /** Files published by one execution. */
            maxFiles: z.number().int().min(1).max(1000).default(200),
            maxFileBytes: z
              .number()
              .int()
              .positive()
              .default(100 * 1024 * 1024),
            /** Total bytes published by one execution. */
            maxOutputBytes: z
              .number()
              .int()
              .positive()
              .default(500 * 1024 * 1024),
            /** Size cap of each stdout/stderr log of a job. */
            maxLogBytes: z
              .number()
              .int()
              .positive()
              .default(10 * 1024 * 1024),
          })
          .strict()
          .default(() => ({
            timeoutMs: 120_000,
            maxFiles: 200,
            maxFileBytes: 100 * 1024 * 1024,
            maxOutputBytes: 500 * 1024 * 1024,
            maxLogBytes: 10 * 1024 * 1024,
          })),
        /** Tabular data (CSV, TSV, JSON, JSONL, XLSX) ingested into one SQLite file per dataset. */
        data: z
          .object({
            /** Largest file ingested (an upload or a workspace file). */
            maxUploadBytes: z
              .number()
              .int()
              .positive()
              .default(200 * 1024 * 1024),
            /** Rows per sheet; a larger file stops the ingestion and leaves no dataset. */
            maxRows: z.number().int().positive().default(5_000_000),
            /** Time limit of one `data_query` statement; the engine process is killed past it. */
            queryTimeoutMs: z.number().int().min(100).max(60_000).default(5000),
            /** Sorting and filtering are disabled above this many rows (the file has no indexes). */
            maxInteractiveRows: z.number().int().positive().default(1_000_000),
          })
          .strict()
          .default(() => ({
            maxUploadBytes: 200 * 1024 * 1024,
            maxRows: 5_000_000,
            queryTimeoutMs: 5000,
            maxInteractiveRows: 1_000_000,
          })),
        /**
         * Retention of analysis data (`0` disables the automatic deletion of that class). Global
         * only: one sweep covers every workspace, so a project layer cannot shorten it.
         */
        retention: z
          .object({
            /** Logs and staging of a job; its script and inputs once no artifact is `ready`. */
            jobsDays: z.number().int().min(0).max(3650).default(30),
            /** The scratch folder (`work/`) of a job. */
            intermediateDays: z.number().int().min(0).max(3650).default(7),
            /** Artifacts older than this become `expired` (folder deleted, row kept). 0 = keep. */
            artifactsDays: z.number().int().min(0).max(3650).default(0),
          })
          .strict()
          .default(() => ({ jobsDays: 30, intermediateDays: 7, artifactsDays: 0 })),
      })
      .strict()
      .default(() => ({
        enabled: true,
        runtime: "managed" as const,
        oci: { engine: "docker" as const, memoryMb: 2048, cpus: 2 },
        retention: { jobsDays: 30, intermediateDays: 7, artifactsDays: 0 },
        limits: {
          timeoutMs: 120_000,
          maxFiles: 200,
          maxFileBytes: 100 * 1024 * 1024,
          maxOutputBytes: 500 * 1024 * 1024,
          maxLogBytes: 10 * 1024 * 1024,
        },
        data: {
          maxUploadBytes: 200 * 1024 * 1024,
          maxRows: 5_000_000,
          queryTimeoutMs: 5000,
          maxInteractiveRows: 1_000_000,
        },
      })),
    /**
     * Background tasks (`bg_run`, `bg_list`, `bg_output`, `bg_stop`). They are ordinary child
     * processes of Alisio (not detached, not sandboxed): they end when Alisio ends. `enabled:
     * false` registers none of the tools (applies from the next start). `retentionDays` is
     * global-only: one sweep covers every workspace, so a project layer cannot shorten it.
     */
    tasks: z
      .object({
        enabled: z.boolean().default(true),
        /** Live (queued, running or stopping) tasks per root session. */
        maxPerSession: z.number().int().min(1).max(32).default(4),
        /** Watchdog: a task still running after this long is stopped and fails with `timeout`. */
        maxRunMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
        /** Size limit of one task log (the head is kept, a short tail is added when it ends). */
        maxOutputBytes: z.number().int().min(65_536).max(104_857_600).default(2_097_152),
        /** Finished task rows and their logs are deleted after this many days (0 keeps them). */
        retentionDays: z.number().int().min(0).max(3650).default(7),
      })
      .strict()
      .default(() => ({
        enabled: true,
        maxPerSession: 4,
        maxRunMs: 3_600_000,
        maxOutputBytes: 2_097_152,
        retentionDays: 7,
      })),
    /**
     * `/goal`: a session objective the runtime keeps working on, with hard caps. The token budget
     * is NOT a setting (none unless the user gives one with `budget=`); without it only the turn
     * and time caps stop a goal. `maxTurns` counts runs (a goal turn is one run); `maxMinutes` is
     * the time spent inside runs. The breakers pause a goal that makes no progress.
     */
    goal: z
      .object({
        enabled: z.boolean().default(true),
        maxTurns: z.number().int().min(1).max(1000).default(50),
        maxMinutes: z.number().int().min(1).max(1440).default(120),
        /** Pause after this many consecutive identical replies (observed, nudged, then paused). */
        repeatedReplyLimit: z.number().int().min(2).max(20).default(3),
        /** Pause after this many consecutive turns without a tool call. */
        noToolTurnsLimit: z.number().int().min(2).max(20).default(3),
        /** Consecutive turns in which the model must report the same blocker before it stops. */
        blockedRepeats: z.number().int().min(1).max(10).default(2),
      })
      .strict()
      .default(() => ({
        enabled: true,
        maxTurns: 50,
        maxMinutes: 120,
        repeatedReplyLimit: 3,
        noToolTurnsLimit: 3,
        blockedRepeats: 2,
      })),
    /**
     * Plan diagrams (`exit_plan`): the plan agent may add Mermaid diagrams to a plan. `diagrams`
     * off removes them from the tool and from the agent's instructions; `maxDiagrams` caps how
     * many one plan keeps (0 to 8). The size and node limits of one diagram are constants.
     */
    plan: z
      .object({
        diagrams: z.boolean().default(true),
        maxDiagrams: z.number().int().min(0).max(8).default(5),
      })
      .strict()
      .default(() => ({ diagrams: true, maxDiagrams: 5 })),
    tui: z
      .object({
        /** Horizontal padding (columns) around the editor input box. Editor-only. */
        paddingX: z.number().int().min(0).max(4).default(1),
        /**
         * Horizontal inset (columns) applied to each side of the transcript content, so
         * agent-written rows keep breathing room from the window borders. Independent of
         * `paddingX` (which styles only the editor input box). Clamped on narrow terminals so the
         * content column never collapses below a usable width.
         */
        contentPaddingX: z.number().int().min(0).max(12).default(2),
        /**
         * Offer effective skills as first-class `skill:<id>` editor slash-autocomplete entries.
         * Off hides those entries; the `/skills` manager and its argument completion stay available.
         */
        skillSlashCommands: z.boolean().default(true),
      })
      .strict()
      .default(() => ({ paddingX: 1, contentPaddingX: 2, skillSlashCommands: true })),
    /**
     * The ACTIVE agent drives the main session: its system prompt is appended to every prompt and
     * its optional model selector is offered when the agent is chosen (`/agents`). `build` is the
     * built-in default (full-power, no added persona); `plan` is the built-in read-only planner.
     * `effort` holds a reasoning effort level chosen with `/effort` for a model that advertises
     * `effort.supportedLevels`; it is validated against the ACTIVE model on use, falling back to
     * the model's default level when unsupported.
     */
    agents: z
      .object({
        active: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "invalid agent name")
          .default("build"),
        effort: z.string().trim().min(1).max(50).optional(),
      })
      .strict()
      .default(() => ({ active: "build" })),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.mcpServers) return;
    for (const name of Object.keys(config.mcpServers))
      if (name in config.mcp.servers)
        context.addIssue({
          code: "custom",
          path: ["mcpServers", name],
          message: `MCP server "${name}" is defined in both mcp.servers and mcpServers`,
        });
  });
export const configSchema = configObjectSchema.transform(({ mcpServers, ...config }) => ({
  ...config,
  mcp: { ...config.mcp, servers: { ...config.mcp.servers, ...mcpServers } },
}));
export type Config = z.infer<typeof configSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type McpServerSourceKind = "global" | "project" | "explicit" | "builtin" | "plugin";
export interface McpServerSource {
  kind: McpServerSourceKind;
  file?: string;
  form: "canonical" | "alias";
}
export type LoadedConfig = Config & { mcpSources: Record<string, McpServerSource> };
export interface ConfigProvenance {
  selectedLayer?: {
    kind: "project" | "explicit";
    hasLegacyProvider: boolean;
  };
  /** Keys a project or explicit layer set that only the global layer may decide (ignored). */
  ignored?: string[];
}
export interface ConfigLoadResult {
  config: LoadedConfig;
  provenance: ConfigProvenance;
}
/** The `alisio setup` scaffold writes this placeholder; a model matching it is not usable. */
const LEGACY_PROVIDER_MODEL_PLACEHOLDER = "YOUR_MODEL_ID";

/**
 * A legacy root `provider` is usable only when its parsed model is non-empty and not the
 * `alisio setup` placeholder, so a scaffolded or empty project config never defeats a saved
 * `/connect` profile.
 */
function isUsableLegacyModel(model: string): boolean {
  const normalized = model.trim();
  return normalized !== "" && normalized !== LEGACY_PROVIDER_MODEL_PLACEHOLDER;
}

/**
 * Appends the entries of `selected` after the `global` list, dropping exact duplicates so the
 * global entries keep their order and the selected layer only ever ADDS to the collection. An
 * empty `selected` list therefore leaves the global list intact. Entries were already resolved
 * per layer by `parseLayer`, so deduplication happens on the resolved strings.
 */
function mergeUnique(global: string[], selected: string[]): string[] {
  const seen = new Set(global);
  const merged = [...global];
  for (const entry of selected)
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  return merged;
}

/** Absolute, canonical directory when it exists; a missing path keeps its resolved absolute form. */
async function canonicalDirectory(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/**
 * Whether legacy provider selection should take priority over a saved plugin profile for this
 * run: an explicit endpoint override, or a trusted project/explicit layer whose parsed root
 * `provider.model` is actually usable (non-empty and not the `alisio setup` placeholder).
 */
export function overridesSavedProviderProfile(
  provenance: ConfigProvenance,
  hasEndpointOverride: boolean,
): boolean {
  return hasEndpointOverride || !!provenance.selectedLayer?.hasLegacyProvider;
}
export const configHome = () =>
  process.env.ALISIO_CONFIG_HOME ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alisio");
export const stateHome = () =>
  process.env.ALISIO_STATE_HOME ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "alisio");
/** Highest-priority configuration file selected for a workspace (it may not exist). */
export function configFile(
  workspace: string,
  options: { file?: string; trustProject?: boolean } = {},
): string {
  // Only explicit/trusted project configuration may redirect credentials to another endpoint.
  return options.file
    ? resolve(options.file)
    : options.trustProject
      ? join(workspace, ".alisio", "config.json")
      : join(configHome(), "config.json");
}
export async function loadConfigWithProvenance(
  workspace: string,
  options: {
    file?: string;
    trustProject?: boolean;
    baseURL?: string;
    model?: string;
    apiMode?: string;
  } = {},
): Promise<ConfigLoadResult> {
  const globalFile = join(configHome(), "config.json");
  const selectedFile = options.file
    ? resolve(options.file)
    : options.trustProject
      ? join(workspace, ".alisio", "config.json")
      : undefined;
  const parseLayer = async (file: string, kind: McpServerSourceKind) => {
    const raw = (await readJson(file)) ?? {};
    const config = configSchema.parse(raw);
    config.skills = config.skills.map((p) => resolve(file, "..", p));
    // Extra tool roots are paths relative to the config file; canonicalize so containment checks
    // compare real directories (a symlinked root never escapes its declared location).
    config.additionalDirectories = await Promise.all(
      config.additionalDirectories.map((p) => canonicalDirectory(resolve(file, "..", p))),
    );
    // Plugin entries are paths (relative to the config file) or npm package names.
    config.plugins = config.plugins.map((p) => (isPathSpec(p) ? resolve(file, "..", p) : p));
    for (const server of Object.values(config.mcp.servers))
      if (server.transport === "stdio") {
        if (server.command.startsWith("./") || server.command.startsWith("../"))
          server.command = resolve(file, "..", server.command);
        server.args = server.args.map((argument) =>
          argument.startsWith("./") || argument.startsWith("../")
            ? resolve(file, "..", argument)
            : argument,
        );
      }
    const object = raw as Record<string, unknown>;
    const canonical =
      object.mcp && typeof object.mcp === "object" && !Array.isArray(object.mcp)
        ? ((object.mcp as Record<string, unknown>).servers as Record<string, unknown> | undefined)
        : undefined;
    const alias = object.mcpServers as Record<string, unknown> | undefined;
    const sources = Object.fromEntries(
      Object.keys(config.mcp.servers).map((name) => [
        name,
        {
          kind,
          file,
          form: canonical && name in canonical ? "canonical" : "alias",
        } as McpServerSource,
      ]),
    );
    const analysisRaw =
      object.analysis && typeof object.analysis === "object" && !Array.isArray(object.analysis)
        ? (object.analysis as Record<string, unknown>)
        : {};
    const tasksRaw =
      object.tasks && typeof object.tasks === "object" && !Array.isArray(object.tasks)
        ? (object.tasks as Record<string, unknown>)
        : {};
    const decisionsRaw =
      object.decisions && typeof object.decisions === "object" && !Array.isArray(object.decisions)
        ? (object.decisions as Record<string, unknown>)
        : {};
    const overridesRaw =
      object.pluginOverrides &&
      typeof object.pluginOverrides === "object" &&
      !Array.isArray(object.pluginOverrides)
        ? (object.pluginOverrides as Record<string, unknown>)
        : {};
    const ignored = [
      ...GLOBAL_ONLY_ANALYSIS.filter((key) => key in analysisRaw).map((key) => `analysis.${key}`),
      ...GLOBAL_ONLY_DECISIONS.filter((key) => key in decisionsRaw).map(
        (key) => `decisions.${key}`,
      ),
      ...Object.entries(overridesRaw)
        .filter(
          ([, entry]) =>
            !!entry && typeof entry === "object" && !Array.isArray(entry) && "options" in entry,
        )
        .map(([id]) => `pluginOverrides.${id}.options`),
      ...("retentionDays" in tasksRaw ? ["tasks.retentionDays"] : []),
    ];
    return { config, keys: new Set(Object.keys(object)), sources, ignored, file };
  };
  const global = await parseLayer(globalFile, "global");
  // Skill activation is deliberately project-local; never carry a similarly named global field
  // into another workspace.
  global.config.skillOverrides = {};
  let config = global.config;
  let mcpSources = global.sources;
  // Parsed `provider.model` of the selected layer itself (before env/CLI overrides), used to
  // decide whether its legacy root `provider` is usable against a saved `/connect` profile.
  let selectedLegacyModel = "";
  let ignoredKeys: string[] = [];
  if (selectedFile && selectedFile !== globalFile) {
    const selected = await parseLayer(selectedFile, options.file ? "explicit" : "project");
    ignoredKeys = selected.ignored;
    selectedLegacyModel = selected.config.provider.model;
    const overlaid = { ...config };
    for (const key of selected.keys) {
      if (key === "mcp" || key === "mcpServers") continue;
      if (!(key in selected.config)) continue;
      // Additive collections: the selected layer ADDS to the global list (global entries
      // first, exact duplicates dropped); an empty selected list never clears the global one.
      if (key === "plugins") {
        overlaid.plugins = mergeUnique(overlaid.plugins, selected.config.plugins);
        continue;
      }
      if (key === "skills") {
        overlaid.skills = mergeUnique(overlaid.skills, selected.config.skills);
        continue;
      }
      if (key === "additionalDirectories") {
        overlaid.additionalDirectories = mergeUnique(
          overlaid.additionalDirectories,
          selected.config.additionalDirectories,
        );
        continue;
      }
      // Additive records: merge by key, the selected layer wins per key.
      if (key === "pluginOverrides") {
        // `options` is global-only: a repository must not inject options into a plugin that has
        // system access, so the selected entry keeps its `enabled` but never its `options`.
        const merged = { ...overlaid.pluginOverrides };
        for (const [id, entry] of Object.entries(selected.config.pluginOverrides)) {
          const options = global.config.pluginOverrides[id]?.options;
          const { options: _ignored, ...rest } = entry;
          merged[id] = { ...global.config.pluginOverrides[id], ...rest };
          if (options) merged[id].options = options;
          else delete merged[id].options;
        }
        overlaid.pluginOverrides = merged;
        continue;
      }
      if (key === "skillOverrides") {
        // Global skill overrides were reset above (skill activation is project-local); the
        // selected overrides still merge into that empty record and win per key.
        overlaid.skillOverrides = { ...overlaid.skillOverrides, ...selected.config.skillOverrides };
        continue;
      }
      if (key === "builtinPlugins") {
        // Per-plugin options merge by plugin id: the selected entry wins per id, so
        // `{id: {enabled: false}}` in the selected layer still disables that built-in while
        // every other global entry stays.
        overlaid.builtinPlugins = { ...overlaid.builtinPlugins, ...selected.config.builtinPlugins };
        continue;
      }
      if (key === "analysis") {
        // `runtime`, `oci` and `retention` are global-only (a repository must not pick the binary
        // that runs scripts, nor shorten the retention of every workspace's data).
        overlaid.analysis = {
          ...selected.config.analysis,
          runtime: global.config.analysis.runtime,
          oci: global.config.analysis.oci,
          retention: global.config.analysis.retention,
        };
        continue;
      }
      if (key === "decisions") {
        // `provider` and `telemetry` are global-only (a repository cannot pick the decision
        // engine nor its telemetry policy); the rest follows the selected layer.
        overlaid.decisions = {
          ...selected.config.decisions,
          provider: global.config.decisions.provider,
          telemetry: global.config.decisions.telemetry,
        };
        continue;
      }
      if (key === "tasks") {
        // `retentionDays` is global-only (one sweep deletes the data of every workspace).
        overlaid.tasks = {
          ...selected.config.tasks,
          retentionDays: global.config.tasks.retentionDays,
        };
        continue;
      }
      (overlaid as unknown as Record<string, unknown>)[key] = (
        selected.config as unknown as Record<string, unknown>
      )[key];
    }
    if (selected.keys.has("mcp") || selected.keys.has("mcpServers"))
      // Only servers merge upward; `mcp.allow` is a global/user preference and is deliberately
      // dropped from the selected layer so a project can never grant itself network consent.
      overlaid.mcp = {
        ...config.mcp,
        servers: { ...config.mcp.servers, ...selected.config.mcp.servers },
      };
    mcpSources = { ...mcpSources, ...selected.sources };
    config = overlaid;
  } else if (selectedFile) {
    selectedLegacyModel = global.config.provider.model;
  }
  config.provider = providerSchema.parse({
    ...config.provider,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    ...(process.env.ALISIO_MODEL ? { model: process.env.ALISIO_MODEL } : {}),
    ...(process.env.ALISIO_API_MODE ? { apiMode: process.env.ALISIO_API_MODE } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.apiMode ? { apiMode: options.apiMode } : {}),
  });
  const url = new URL(config.provider.baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("baseURL must be an HTTP(S) URL without credentials");
  return {
    config: { ...config, mcpSources },
    provenance: {
      ...(selectedFile
        ? {
            selectedLayer: {
              kind: options.file ? ("explicit" as const) : ("project" as const),
              hasLegacyProvider: isUsableLegacyModel(selectedLegacyModel),
            },
          }
        : {}),
      ...(ignoredKeys.length ? { ignored: ignoredKeys } : {}),
    },
  };
}

export async function loadConfig(
  workspace: string,
  options: {
    file?: string;
    trustProject?: boolean;
    baseURL?: string;
    model?: string;
    apiMode?: string;
  } = {},
): Promise<LoadedConfig> {
  return (await loadConfigWithProvenance(workspace, options)).config;
}

/** Atomically toggles one MCP server in the form and file that defined it. */
export async function setMcpServerEnabled(input: {
  source: McpServerSource;
  name: string;
  enabled: boolean;
}): Promise<string> {
  if (!input.source.file) throw new Error("This MCP server is managed by its registering plugin");
  const file = input.source.file;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Alisio configuration must be a JSON object");
  const raw = parsed as Record<string, unknown>;
  const container =
    input.source.form === "alias"
      ? raw.mcpServers
      : raw.mcp && typeof raw.mcp === "object" && !Array.isArray(raw.mcp)
        ? (raw.mcp as Record<string, unknown>).servers
        : undefined;
  if (!container || typeof container !== "object" || Array.isArray(container))
    throw new Error(
      `MCP server "${input.name}" is no longer present in its defining configuration`,
    );
  const current = (container as Record<string, unknown>)[input.name];
  if (!current || typeof current !== "object" || Array.isArray(current))
    throw new Error(
      `MCP server "${input.name}" is no longer present in its defining configuration`,
    );
  (container as Record<string, unknown>)[input.name] = {
    ...(current as Record<string, unknown>),
    enabled: input.enabled,
  };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return file;
}

/** Atomically sets or clears the global `mcp.allow` consent preference in the user config file. */
export async function setGlobalMcpAllow(input: { allow: boolean }): Promise<string> {
  const file = join(configHome(), "config.json");
  let raw: Record<string, unknown> = {};
  if (await exists(file)) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Global Alisio configuration must be a JSON object");
    raw = parsed as Record<string, unknown>;
  }
  if (input.allow) {
    const current =
      raw.mcp && typeof raw.mcp === "object" && !Array.isArray(raw.mcp)
        ? (raw.mcp as Record<string, unknown>)
        : {};
    raw.mcp = { ...current, allow: true };
  } else if (raw.mcp && typeof raw.mcp === "object" && !Array.isArray(raw.mcp)) {
    const mcp = { ...(raw.mcp as Record<string, unknown>) };
    delete mcp.allow;
    if (Object.keys(mcp).length) raw.mcp = mcp;
    else delete raw.mcp;
  }
  raw.schemaVersion ??= 1;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return file;
}

/**
 * The user-facing settings writable through the atomic `setConfigValue` writer, with their zod
 * leaf validators derived from the config schema. Only these keys are accepted; every other
 * config path stays out of reach of the settings menu (unknown keys are rejected, never created).
 */
const SETTABLE_SECTIONS = {
  compaction: configObjectSchema.shape.compaction.removeDefault(),
  context: configObjectSchema.shape.context.removeDefault(),
  limits: configObjectSchema.shape.limits.removeDefault(),
  pluginHooks: configObjectSchema.shape.pluginHooks.removeDefault(),
  decisions: configObjectSchema.shape.decisions.removeDefault(),
  tui: configObjectSchema.shape.tui.removeDefault(),
  websearch: configObjectSchema.shape.websearch.removeDefault(),
  agents: configObjectSchema.shape.agents.removeDefault(),
  analysis: configObjectSchema.shape.analysis.removeDefault(),
  tasks: configObjectSchema.shape.tasks.removeDefault(),
  goal: configObjectSchema.shape.goal.removeDefault(),
  plan: configObjectSchema.shape.plan.removeDefault(),
} as const;
const ANALYSIS_LIMITS = SETTABLE_SECTIONS.analysis.shape.limits.removeDefault();
const ANALYSIS_RETENTION = SETTABLE_SECTIONS.analysis.shape.retention.removeDefault();
const SETTABLE_KEYS = {
  "compaction.auto": SETTABLE_SECTIONS.compaction.shape.auto,
  "compaction.threshold": SETTABLE_SECTIONS.compaction.shape.threshold,
  "compaction.keepTurns": SETTABLE_SECTIONS.compaction.shape.keepTurns,
  "compaction.maxOutputTokens": SETTABLE_SECTIONS.compaction.shape.maxOutputTokens,
  "context.claudeMdFallback": SETTABLE_SECTIONS.context.shape.claudeMdFallback,
  "context.maxBytes": SETTABLE_SECTIONS.context.shape.maxBytes,
  "limits.maxTurns": SETTABLE_SECTIONS.limits.shape.maxTurns,
  "limits.maxOutputTokens": SETTABLE_SECTIONS.limits.shape.maxOutputTokens,
  "limits.maxContextChars": SETTABLE_SECTIONS.limits.shape.maxContextChars,
  "limits.timeoutMs": SETTABLE_SECTIONS.limits.shape.timeoutMs,
  "limits.firstTokenTimeoutMs": SETTABLE_SECTIONS.limits.shape.firstTokenTimeoutMs,
  "limits.firstTokenRetries": SETTABLE_SECTIONS.limits.shape.firstTokenRetries,
  "limits.truncationRecoveries": SETTABLE_SECTIONS.limits.shape.truncationRecoveries,
  "pluginHooks.timeoutMs": SETTABLE_SECTIONS.pluginHooks.shape.timeoutMs,
  "pluginHooks.disposeTimeoutMs": SETTABLE_SECTIONS.pluginHooks.shape.disposeTimeoutMs,
  "decisions.enabled": SETTABLE_SECTIONS.decisions.shape.enabled,
  "decisions.provider": SETTABLE_SECTIONS.decisions.shape.provider,
  "decisions.timeoutMs": SETTABLE_SECTIONS.decisions.shape.timeoutMs,
  "decisions.minConfidence": SETTABLE_SECTIONS.decisions.shape.minConfidence,
  "decisions.telemetry": SETTABLE_SECTIONS.decisions.shape.telemetry,
  "tui.paddingX": SETTABLE_SECTIONS.tui.shape.paddingX,
  "tui.contentPaddingX": SETTABLE_SECTIONS.tui.shape.contentPaddingX,
  "tui.skillSlashCommands": SETTABLE_SECTIONS.tui.shape.skillSlashCommands,
  "websearch.provider": SETTABLE_SECTIONS.websearch.shape.provider,
  "agents.active": SETTABLE_SECTIONS.agents.shape.active,
  "agents.effort": SETTABLE_SECTIONS.agents.shape.effort,
  "analysis.enabled": SETTABLE_SECTIONS.analysis.shape.enabled,
  "analysis.limits.timeoutMs": ANALYSIS_LIMITS.shape.timeoutMs,
  "analysis.retention.jobsDays": ANALYSIS_RETENTION.shape.jobsDays,
  "analysis.retention.intermediateDays": ANALYSIS_RETENTION.shape.intermediateDays,
  "analysis.retention.artifactsDays": ANALYSIS_RETENTION.shape.artifactsDays,
  "tasks.enabled": SETTABLE_SECTIONS.tasks.shape.enabled,
  "tasks.maxPerSession": SETTABLE_SECTIONS.tasks.shape.maxPerSession,
  "tasks.maxRunMs": SETTABLE_SECTIONS.tasks.shape.maxRunMs,
  "tasks.maxOutputBytes": SETTABLE_SECTIONS.tasks.shape.maxOutputBytes,
  "tasks.retentionDays": SETTABLE_SECTIONS.tasks.shape.retentionDays,
  "goal.enabled": SETTABLE_SECTIONS.goal.shape.enabled,
  "goal.maxTurns": SETTABLE_SECTIONS.goal.shape.maxTurns,
  "goal.maxMinutes": SETTABLE_SECTIONS.goal.shape.maxMinutes,
  "goal.repeatedReplyLimit": SETTABLE_SECTIONS.goal.shape.repeatedReplyLimit,
  "goal.noToolTurnsLimit": SETTABLE_SECTIONS.goal.shape.noToolTurnsLimit,
  "goal.blockedRepeats": SETTABLE_SECTIONS.goal.shape.blockedRepeats,
  "plan.diagrams": SETTABLE_SECTIONS.plan.shape.diagrams,
  "plan.maxDiagrams": SETTABLE_SECTIONS.plan.shape.maxDiagrams,
} as const satisfies Record<string, z.ZodTypeAny>;
export type SettableSettingKey = keyof typeof SETTABLE_KEYS;
export function isSettableSettingKey(key: string): key is SettableSettingKey {
  return Object.prototype.hasOwnProperty.call(SETTABLE_KEYS, key);
}

export interface SettableSettingInfo {
  key: SettableSettingKey;
  kind: "boolean" | "number" | "string" | "enum";
  options?: string[];
}

/** Unwraps optional/default/nullable wrappers down to the value schema. */
function settingLeaf(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema as z.ZodTypeAny & { def?: { type?: string; innerType?: z.ZodTypeAny } };
  for (let depth = 0; depth < 8; depth++) {
    const type = current.def?.type;
    if (
      (type === "optional" || type === "default" || type === "nullable") &&
      current.def?.innerType
    )
      current = current.def.innerType as typeof current;
    else break;
  }
  return current;
}

/** Every settable key with its value kind (and enum options), for settings editors. */
export function settableSettings(): SettableSettingInfo[] {
  return (Object.keys(SETTABLE_KEYS) as SettableSettingKey[]).map((key) => {
    const leaf = settingLeaf(SETTABLE_KEYS[key]) as z.ZodTypeAny & {
      def?: { type?: string };
      options?: unknown[];
    };
    const type = leaf.def?.type;
    if (type === "enum")
      return { key, kind: "enum", options: (leaf.options ?? []).map((o) => String(o)) };
    if (type === "boolean") return { key, kind: "boolean" };
    if (type === "number" || type === "int") return { key, kind: "number" };
    return { key, kind: "string" };
  });
}

/**
 * Atomically sets one user-facing setting in the global config file (`<config home>/config.json`)
 * while preserving every unrelated JSON field. The value is validated against the same zod leaf
 * used by `configSchema`, so a write can never produce a config the loader would reject. The
 * caller is responsible for applying the change to the running process (see `application.ts`).
 */
export async function setConfigValue(input: {
  key: SettableSettingKey;
  value: unknown;
}): Promise<string> {
  const validator = SETTABLE_KEYS[input.key];
  if (!validator) throw new Error(`Unknown setting key: ${input.key}`);
  const parsed = validator.safeParse(input.value);
  if (!parsed.success) {
    const detail = parsed.error.issues[0];
    throw new Error(
      detail
        ? `Invalid value for ${input.key}: ${detail.path.join(".") || "value"} ${detail.message}`
        : `Invalid value for ${input.key}`,
    );
  }
  const file = join(configHome(), "config.json");
  let raw: Record<string, unknown> = {};
  if (await exists(file)) {
    const existing: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw new Error("Global Alisio configuration must be a JSON object");
    raw = existing as Record<string, unknown>;
  }
  // Keys are `section.leaf` or `section.group.leaf`: every object on the path keeps its other fields.
  const path = input.key.split(".");
  const setPath = (target: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const name = path[depth] as string;
    if (depth === path.length - 1) return { ...target, [name]: parsed.data };
    const child = target[name];
    return {
      ...target,
      [name]: setPath(
        child && typeof child === "object" && !Array.isArray(child)
          ? (child as Record<string, unknown>)
          : {},
        depth + 1,
      ),
    };
  };
  raw = setPath(raw, 0);
  raw.schemaVersion ??= 1;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return file;
}

/** Atomically updates one project plugin override while preserving every unrelated JSON field. */
export async function setProjectPluginEnabled(input: {
  workspace: string;
  id: string;
  enabled: boolean;
  builtin: boolean;
  trusted: boolean;
}): Promise<string> {
  const file = join(input.workspace, ".alisio", "config.json");
  let raw: Record<string, unknown> = {};
  if (await exists(file)) {
    if (!input.trusted)
      throw new Error("Trust this project before changing its existing Alisio configuration");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Project Alisio configuration must be a JSON object");
    raw = parsed as Record<string, unknown>;
  }
  if (input.builtin) {
    const current =
      raw.builtinPlugins &&
      typeof raw.builtinPlugins === "object" &&
      !Array.isArray(raw.builtinPlugins)
        ? (raw.builtinPlugins as Record<string, unknown>)
        : {};
    const entry =
      current[input.id] &&
      typeof current[input.id] === "object" &&
      !Array.isArray(current[input.id])
        ? (current[input.id] as Record<string, unknown>)
        : {};
    raw.builtinPlugins = { ...current, [input.id]: { ...entry, enabled: input.enabled } };
  } else {
    const current =
      raw.pluginOverrides &&
      typeof raw.pluginOverrides === "object" &&
      !Array.isArray(raw.pluginOverrides)
        ? (raw.pluginOverrides as Record<string, unknown>)
        : {};
    const entry =
      current[input.id] &&
      typeof current[input.id] === "object" &&
      !Array.isArray(current[input.id])
        ? (current[input.id] as Record<string, unknown>)
        : {};
    // Keep the other fields of the entry (`options`): toggling a plugin must not erase them.
    raw.pluginOverrides = { ...current, [input.id]: { ...entry, enabled: input.enabled } };
  }
  raw.schemaVersion ??= 1;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return file;
}

/** Atomically updates one project skill override while preserving every unrelated JSON field. */
export async function setProjectSkillEnabled(input: {
  workspace: string;
  id: string;
  enabled: boolean;
  trusted: boolean;
}): Promise<string> {
  const file = join(input.workspace, ".alisio", "config.json");
  let raw: Record<string, unknown> = {};
  if (await exists(file)) {
    if (!input.trusted)
      throw new Error("Trust this project before changing its existing Alisio configuration");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Project Alisio configuration must be a JSON object");
    raw = parsed as Record<string, unknown>;
  }
  const current =
    raw.skillOverrides &&
    typeof raw.skillOverrides === "object" &&
    !Array.isArray(raw.skillOverrides)
      ? (raw.skillOverrides as Record<string, unknown>)
      : {};
  raw.skillOverrides = { ...current, [input.id]: { enabled: input.enabled } };
  raw.schemaVersion ??= 1;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return file;
}
