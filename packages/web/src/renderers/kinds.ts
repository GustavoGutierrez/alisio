/**
 * Which view renders each `UiBlock` kind (spec §10.4). Kept apart from the lazy `import()`
 * table in `registry.ts` so it can be tested without loading views. Unknown kinds (for example
 * blocks persisted by a newer Alisio) use the fallback.
 */
export const RENDERER_KINDS = [
  "table",
  "key-value",
  "tree",
  "code",
  "markdown",
  "diff",
  "terminal",
  "mermaid",
  "math",
  "json",
  "test-results",
  "progress",
] as const;

export type RendererKind = (typeof RENDERER_KINDS)[number] | "fallback";

export const rendererFor = (kind: string): RendererKind =>
  (RENDERER_KINDS as readonly string[]).includes(kind) ? (kind as RendererKind) : "fallback";
