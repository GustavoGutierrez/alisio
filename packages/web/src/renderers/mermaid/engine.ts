/**
 * The heavy half of the Mermaid renderer: Mermaid itself and DOMPurify, imported only when a
 * diagram scrolls into view. Renders are serialized (Mermaid keeps global state) and the engine
 * is re-initialized when the theme changes.
 */
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { type MermaidResult, mermaidConfig, renderMermaid } from "./render.ts";

let configured: "dark" | "light" | undefined;
let counter = 0;
let queue: Promise<unknown> = Promise.resolve();

const sanitizeSvg = (svg: string): string =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
  });

export function render(source: string, theme: "dark" | "light"): Promise<MermaidResult> {
  const job = queue.then(() => {
    if (configured !== theme) {
      mermaid.initialize(mermaidConfig(theme));
      configured = theme;
    }
    counter += 1;
    return renderMermaid(mermaid, `alisio-mermaid-${counter}`, source, sanitizeSvg);
  });
  queue = job.catch(() => {});
  return job;
}
