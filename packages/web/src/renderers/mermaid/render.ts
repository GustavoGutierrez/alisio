/**
 * Mermaid rendering as a pure function over an injected engine (spec §10.4): strict security,
 * SVG labels only (no HTML in `foreignObject`), and the SVG sanitized before it reaches the DOM.
 * A parse or render failure comes back as `{error}` so the view shows the source instead.
 */
export interface MermaidEngine {
  parse(source: string): Promise<unknown>;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export type MermaidResult = { svg: string } | { error: string };

export function mermaidConfig(theme: "dark" | "light") {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: theme === "dark" ? "dark" : "default",
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
