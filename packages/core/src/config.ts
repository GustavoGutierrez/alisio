import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
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
const configObjectSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    provider: providerSchema.default(() => providerSchema.parse({})),
    plugins: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
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
    pluginOverrides: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()).default({}),
    /** Host-enforced timeouts for plugin hooks. */
    pluginHooks: z
      .object({
        timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
        sessionEndTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
      })
      .strict()
      .default(() => ({ timeoutMs: 15_000, sessionEndTimeoutMs: 10_000 })),
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
          .enum(["searxng", "duckduckgo-instant", "tavily", "brave", "serpapi", "native"])
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
        timeoutMs: z.number().int().min(100).default(300000),
        maxContextChars: z.number().int().positive().default(800000),
        /**
         * Per-call output token budget for one agent turn. 4096 starves reasoning-heavy models,
         * which can spend the whole budget on `reasoning_content` before any usable text arrives.
         */
        maxOutputTokens: z.number().int().positive().default(16384),
        /** Cumulative tokens per run; default is proportional to the context window. */
        maxTokens: z.number().int().positive().optional(),
      })
      .default(() => ({
        maxTurns: 100,
        timeoutMs: 300000,
        maxContextChars: 800000,
        maxOutputTokens: 16384,
      })),
    tui: z
      .object({
        /** Horizontal padding (columns) around the editor input box. */
        paddingX: z.number().int().min(0).max(4).default(1),
        /**
         * Offer effective skills as first-class `skill:<id>` editor slash-autocomplete entries.
         * Off hides those entries; the `/skills` manager and its argument completion stay available.
         */
        skillSlashCommands: z.boolean().default(true),
      })
      .strict()
      .default(() => ({ paddingX: 1, skillSlashCommands: true })),
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
    return { config, keys: new Set(Object.keys(object)), sources };
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
  if (selectedFile && selectedFile !== globalFile) {
    const selected = await parseLayer(selectedFile, options.file ? "explicit" : "project");
    selectedLegacyModel = selected.config.provider.model;
    const overlaid = { ...config };
    for (const key of selected.keys) {
      if (key === "mcp" || key === "mcpServers") continue;
      if (key in selected.config)
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
  tui: configObjectSchema.shape.tui.removeDefault(),
  websearch: configObjectSchema.shape.websearch.removeDefault(),
} as const;
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
  "pluginHooks.timeoutMs": SETTABLE_SECTIONS.pluginHooks.shape.timeoutMs,
  "tui.paddingX": SETTABLE_SECTIONS.tui.shape.paddingX,
  "tui.skillSlashCommands": SETTABLE_SECTIONS.tui.shape.skillSlashCommands,
  "websearch.provider": SETTABLE_SECTIONS.websearch.shape.provider,
} as const satisfies Record<string, z.ZodTypeAny>;
export type SettableSettingKey = keyof typeof SETTABLE_KEYS;
export function isSettableSettingKey(key: string): key is SettableSettingKey {
  return Object.prototype.hasOwnProperty.call(SETTABLE_KEYS, key);
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
  const [section, leaf] = input.key.split(".") as [string, string];
  const container =
    raw[section] && typeof raw[section] === "object" && !Array.isArray(raw[section])
      ? (raw[section] as Record<string, unknown>)
      : {};
  raw[section] = { ...container, [leaf]: parsed.data };
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
    raw.pluginOverrides = { ...current, [input.id]: { enabled: input.enabled } };
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
