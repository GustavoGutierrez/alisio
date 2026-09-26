import { z } from "zod";

const cliAgent = z.object({
  description: z.string().min(1),
  prompt: z.string().default(""),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});
/** Options under `builtinPlugins.subagents`. */
export const subagentsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxDepth: z.number().int().min(1).max(8).default(3),
    maxConcurrentPerParent: z.number().int().min(1).max(32).default(4),
    maxConcurrentTotal: z.number().int().min(1).max(64).default(8),
    /** Waiting tasks beyond the concurrency limits; more fail fast. */
    maxQueued: z.number().int().min(0).max(256).default(16),
    maxTurns: z.number().int().min(1).max(500).default(50),
    timeoutMs: z.number().int().min(1_000).default(600_000),
    /** Per-child cumulative token budget; default follows the core proportional budget. */
    maxTokensPerChild: z.number().int().positive().optional(),
    /** Parallel write-capable children in a git repository. */
    parallelWrites: z.enum(["ask", "worktree", "serial", "shared"]).default("ask"),
    waitMaxMs: z.number().int().min(100).default(600_000),
    resultMaxBytes: z.number().int().min(1_000).max(1_000_000).default(50_000),
    /** Agents from `--agents <json>` (highest precedence). */
    agents: z.record(z.string(), cliAgent).default({}),
    /** Where worktrees are created (default `<state>/worktrees`). */
    worktreeDir: z.string().optional(),
  })
  .strict();
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
