/**
 * Which view renders each `UiBlock` kind (spec §10.4). Kept apart from the lazy `import()`
 * table in `registry.ts` so it can be tested without loading views. Unknown kinds (for example
 * blocks persisted by a newer Alisio) use the fallback.
 */

/** Kinds whose view ships in the initial bundle (Markdown fences use `code` constantly). */
export const SYNC_KINDS = ["code", "fallback"] as const;

/** Kinds whose view is a dynamic import (its own chunk, loaded on first use). */
export const LAZY_KINDS = [
  "table",
  "key-value",
  "tree",
  "markdown",
  "diff",
  "terminal",
  "json",
  "test-results",
  "progress",
  "mermaid",
  "math",
  "artifact",
] as const;

export const RENDERER_KINDS = [
  ...SYNC_KINDS.filter((k): k is "code" => k !== "fallback"),
  ...LAZY_KINDS,
] as const;

export type LazyKind = (typeof LAZY_KINDS)[number];
export type RendererKind = (typeof RENDERER_KINDS)[number] | "fallback";

export const rendererFor = (kind: string): RendererKind =>
  (RENDERER_KINDS as readonly string[]).includes(kind) ? (kind as RendererKind) : "fallback";
