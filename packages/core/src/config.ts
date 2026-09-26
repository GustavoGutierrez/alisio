import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readJson } from "./runtime/fs.ts";
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
const serverSchema = z
  .object({
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.url().optional(),
    envAllow: z.array(z.string()).default([]),
    bearerTokenEnv: z.string().optional(),
  })
  .strict();
export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    provider: providerSchema.default(() => providerSchema.parse({})),
    plugins: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    mcp: z
      .object({ servers: z.record(z.string(), serverSchema).default({}) })
      .default({ servers: {} }),
    /** Built-in plugin options keyed by id; each plugin validates its own section. */
    builtinPlugins: z
      .record(z.string(), z.object({ enabled: z.boolean().optional() }).passthrough())
      .default({}),
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
      })
      .strict()
      .default(() => ({ auto: true, threshold: 0.85, keepTurns: 2 })),
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
        maxTurns: z.number().int().min(1).max(100).default(20),
        timeoutMs: z.number().int().min(100).default(300000),
        maxContextChars: z.number().int().positive().default(160000),
        maxOutputTokens: z.number().int().positive().default(4096),
        /** Cumulative tokens per run; default is proportional to the context window. */
        maxTokens: z.number().int().positive().optional(),
      })
      .default(() => ({
        maxTurns: 20,
        timeoutMs: 300000,
        maxContextChars: 160000,
        maxOutputTokens: 4096,
      })),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export const configHome = () =>
  process.env.ALISIO_CONFIG_HOME ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alisio");
export const stateHome = () =>
  process.env.ALISIO_STATE_HOME ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "alisio");
/** Configuration file selected for a workspace (it may not exist). */
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
export async function loadConfig(
  workspace: string,
  options: {
    file?: string;
    trustProject?: boolean;
    baseURL?: string;
    model?: string;
    apiMode?: string;
  } = {},
): Promise<Config> {
  const file = configFile(workspace, options);
  const raw = (await readJson(file)) ?? {};
  const config = configSchema.parse(raw);
  config.skills = config.skills.map((p) => resolve(file, "..", p));
  // Plugin entries are paths (relative to the config file) or npm package names.
  config.plugins = config.plugins.map((p) => (isPathSpec(p) ? resolve(file, "..", p) : p));
  for (const server of Object.values(config.mcp.servers))
    if (server.transport === "stdio")
      server.args = server.args.map((a) =>
        a.startsWith("./") || a.startsWith("../") ? resolve(file, "..", a) : a,
      );
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
  return config;
}
