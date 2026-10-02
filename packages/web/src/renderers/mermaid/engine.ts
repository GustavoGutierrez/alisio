/**
 * The heavy half of the Mermaid renderer: Mermaid itself and DOMPurify, imported only when a
 * diagram scrolls into view. Renders are serialized (Mermaid keeps global state) and the engine
 * is re-initialized when the theme changes.
 */
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { applyPalette } from "./palette.ts";
import { type MermaidResult, mermaidConfig, renderMermaid } from "./render.ts";

let configured: string | undefined;
let counter = 0;
let queue: Promise<unknown> = Promise.resolve();

const sanitizeSvg = (svg: string): string =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
  });

/** `themed` (the plan viewer) applies Alisio's theme and palette classes; chat blocks do not. */
export function render(
  source: string,
  theme: "dark" | "light",
  themed = false,
): Promise<MermaidResult> {
  const job = queue.then(() => {
    const key = `${theme}${themed ? ":alisio" : ""}`;
    if (configured !== key) {
      mermaid.initialize(mermaidConfig(theme, themed));
      configured = key;
    }
    counter += 1;
    return renderMermaid(
      mermaid,
      `alisio-mermaid-${counter}`,
      themed ? applyPalette(source, theme) : source,
      sanitizeSvg,
    );
  });
  queue = job.catch(() => {});
  return job;
}
