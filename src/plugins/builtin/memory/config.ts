import { z } from "zod";

/** Options under `builtinPlugins.memory` in the Alisio configuration. */
export const memoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Defaults to `<state home>/memory.sqlite`; relative paths resolve from the config file. */
    dbPath: z.string().min(1).optional(),
    /** Token budget for injected memory context (session start and after compaction). */
    injectBudgetTokens: z.number().int().min(100).max(20_000).default(1500),
    /** Memories recalled after compaction. */
    recallLimit: z.number().int().min(0).max(20).default(8),
    /** Write a session summary via the provider on /clear, /exit or quit (TUI). */
    autoSummary: z.boolean().default(true),
    defaultScope: z.enum(["project", "personal"]).default("project"),
  })
  .strict();
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
