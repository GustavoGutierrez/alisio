/**
 * Mermaid rendering as a pure function over an injected engine (spec §10.4): strict security,
 * SVG labels only (no HTML in `foreignObject`), and the SVG sanitized before it reaches the DOM.
 * A parse or render failure comes back as `{error}` so the view shows the source instead.
 */
import { themeVariables } from "./palette.ts";

export interface MermaidEngine {
  parse(source: string): Promise<unknown>;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export type MermaidResult = { svg: string } | { error: string };

/**
 * The engine configuration. `themed` is the plan viewer's Alisio theme (Mermaid's `base` theme
 * with Alisio's colors); chat messages and Markdown previews keep Mermaid's own light and dark
 * themes. The security settings never depend on it.
 */
export function mermaidConfig(theme: "dark" | "light", themed = false) {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: themed ? "base" : theme === "dark" ? "dark" : "default",
    ...(themed ? { themeVariables: themeVariables(theme) } : {}),
    maxTextSize: 100_000,
    fontFamily: "inherit",
  } as const;
}

export async function renderMermaid(
  engine: MermaidEngine,
  id: string,
  source: string,
  sanitize: (svg: string) => string,
): Promise<MermaidResult> {
  try {
    await engine.parse(source);
    const { svg } = await engine.render(id, source);
    const clean = sanitize(svg);
    if (!clean.trim()) return { error: "The diagram produced no drawable output" };
    return { svg: clean };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
