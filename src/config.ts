import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

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
    compaction: z
      .object({
        auto: z.boolean().default(true),
        threshold: z.number().min(0.1).max(0.99).default(0.85),
        keepTurns: z.number().int().min(0).max(20).default(2),
      })
      .strict()
      .default(() => ({ auto: true, threshold: 0.85, keepTurns: 2 })),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(100).default(20),
        timeoutMs: z.number().int().min(100).default(300000),
        maxContextChars: z.number().int().positive().default(160000),
        maxOutputTokens: z.number().int().positive().default(4096),
        maxTokens: z.number().int().positive().default(100000),
      })
      .default(() => ({
        maxTurns: 20,
        timeoutMs: 300000,
        maxContextChars: 160000,
        maxOutputTokens: 4096,
        maxTokens: 100000,
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
  const raw = (await Bun.file(file).exists()) ? await Bun.file(file).json() : {};
  const config = configSchema.parse(raw);
  for (const field of ["plugins", "skills"] as const)
    config[field] = config[field].map((p) => resolve(file, "..", p));
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
