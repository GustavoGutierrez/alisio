/**
 * Special fences of assistant Markdown (spec §10.5): a fence's language picks the `UiBlock` the
 * renderer registry shows. Plain code stays `code`; long JSON becomes a `json` tree.
 */
import type { UiBlock } from "@alisio/sdk";

const JSON_TREE_MIN_LINES = 20;

export function fenceBlock(lang: string | undefined, text: string): UiBlock {
  const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (language === "mermaid") return { kind: "mermaid", source: text };
  if (language === "math" || language === "latex" || language === "katex")
    return { kind: "math", latex: text, display: true };
  if (language === "diff" || language === "patch") return { kind: "diff", patch: text };
  if (language === "json" && text.split("\n").length > JSON_TREE_MIN_LINES) {
    try {
      return { kind: "json", value: JSON.parse(text) as unknown };
    } catch {
      /* not valid JSON: show it as code */
    }
  }
  return { kind: "code", ...(language ? { lang: language } : {}), code: text };
}

/** A paragraph that is exactly `$$ … $$` is display math (inline `$…$` stays text). */
export function mathBlock(paragraph: string): UiBlock | undefined {
  const match = /^\$\$([\s\S]+?)\$\$$/.exec(paragraph.trim());
  const latex = match?.[1]?.trim();
  return latex ? { kind: "math", latex, display: true } : undefined;
}
